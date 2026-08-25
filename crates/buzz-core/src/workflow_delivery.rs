//! Canonical, zero-I/O vocabulary for durable workflow message delivery.
//!
//! This module intentionally describes protocol identity only. Persistence,
//! relay admission, wake publication, and ACP dispatch are owned by later
//! delivery-tree nodes.

use std::fmt;

use nostr::{Event, EventBuilder, EventId, Kind, PublicKey, Tag};
use thiserror::Error;
use uuid::Uuid;

use crate::{kind::KIND_WORKFLOW_AGENT_WAKE, tenant::CommunityId};

/// The target class admitted by the durable workflow delivery protocol.
pub const WORKFLOW_DELIVERY_TARGET: &str = "message-v1";
/// NIP-10 marker used on a `p` tag to identify a managed-agent recipient.
pub const WORKFLOW_DELIVERY_TARGET_MARKER: &str = "message-v1";
/// Tag naming a durable delivery on an ephemeral wake hint.
pub const WORKFLOW_DELIVERY_WAKE_TAG: &str = "delivery";

/// One stable durable-delivery identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct WorkflowDeliveryId(Uuid);

impl WorkflowDeliveryId {
    /// Construct an identifier from its UUID representation.
    pub const fn from_uuid(id: Uuid) -> Self {
        Self(id)
    }

    /// Return the UUID representation.
    pub const fn as_uuid(self) -> Uuid {
        self.0
    }
}

impl fmt::Display for WorkflowDeliveryId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// Immutable identity which must agree across durable state, visible message,
/// wake hints, API requests, and ACP verification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowDeliveryBinding {
    /// Server-resolved community that owns the delivery.
    pub community_id: CommunityId,
    /// Workflow definition selected for the run.
    pub workflow_id: Uuid,
    /// Durable workflow run.
    pub run_id: Uuid,
    /// Stable, non-empty workflow step identifier.
    pub step_id: String,
    /// Managed agent allowed to claim the delivery.
    pub target_pubkey: PublicKey,
    /// Exact owner-signed kind-30620 definition revision.
    pub definition_event_id: EventId,
    /// Visible kind-9 message created for this delivery.
    pub message_event_id: EventId,
    /// Canonical identity of the authority that caused this run.
    pub cause: WorkflowDeliveryCause,
}

impl WorkflowDeliveryBinding {
    /// Construct and validate a canonical binding.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        community_id: CommunityId,
        workflow_id: Uuid,
        run_id: Uuid,
        step_id: impl Into<String>,
        target_pubkey: PublicKey,
        definition_event_id: EventId,
        message_event_id: EventId,
        cause: WorkflowDeliveryCause,
    ) -> Result<Self, WorkflowDeliveryError> {
        let step_id = step_id.into();
        if step_id.trim().is_empty() {
            return Err(WorkflowDeliveryError::EmptyStepId);
        }
        Ok(Self {
            community_id,
            workflow_id,
            run_id,
            step_id,
            target_pubkey,
            definition_event_id,
            message_event_id,
            cause,
        })
    }

    /// Validate the visible message against this binding's `message-v1` admission rule.
    pub fn validate_message_event(&self, event: &Event) -> Result<(), WorkflowDeliveryError> {
        if event.kind.as_u16() != 9 {
            return Err(WorkflowDeliveryError::WrongMessageKind(event.kind.as_u16()));
        }
        if event.id != self.message_event_id {
            return Err(WorkflowDeliveryError::MessageEventIdMismatch);
        }
        if !message_v1_targets(event)?.contains(&self.target_pubkey) {
            return Err(WorkflowDeliveryError::MissingMessageV1Target);
        }
        Ok(())
    }

    /// Return the canonical `p` tag that opts this recipient into `message-v1`.
    ///
    /// Later producers derive durable targets only from this marker-bearing tag,
    /// never from ordinary mentions.
    pub fn message_v1_target_tag(&self) -> Result<Tag, WorkflowDeliveryError> {
        parse_tag([
            "p",
            &self.target_pubkey.to_hex(),
            "",
            WORKFLOW_DELIVERY_TARGET_MARKER,
        ])
    }
}

/// Identity of the distinct authority classes that can cause a workflow run.
///
/// Webhook identity is an opaque server-generated invocation ID: private
/// webhook payload and secrets deliberately never appear in messages or wakes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkflowDeliveryCause {
    /// A signed trigger or owner-command event.
    Event(EventId),
    /// A scheduled firing at this exact Unix-second slot.
    Schedule {
        /// Authoritative schedule instant, measured in Unix seconds.
        scheduled_for_unix_seconds: i64,
    },
    /// An opaque, durable server-side webhook invocation identity.
    Webhook {
        /// Stable invocation UUID, not a webhook secret or payload.
        invocation_id: Uuid,
    },
}

/// Parse all unique managed-agent recipients admitted by `message-v1` tags.
///
/// Other normal kind-9 tags are intentionally ignored. A malformed tag which
/// claims the `message-v1` marker fails closed rather than becoming a target.
pub fn message_v1_targets(event: &Event) -> Result<Vec<PublicKey>, WorkflowDeliveryError> {
    if event.kind.as_u16() != 9 {
        return Err(WorkflowDeliveryError::WrongMessageKind(event.kind.as_u16()));
    }
    let mut targets = Vec::new();
    for tag in event.tags.iter() {
        let values = tag.as_slice();
        if values.first().map(String::as_str) != Some("p")
            || values.get(3).map(String::as_str) != Some(WORKFLOW_DELIVERY_TARGET_MARKER)
        {
            continue;
        }
        if values.len() != 4 {
            return Err(WorkflowDeliveryError::InvalidMessageV1Tag);
        }
        let target = parse_pubkey(&values[1])?;
        if targets.contains(&target) {
            return Err(WorkflowDeliveryError::DuplicateMessageV1Target);
        }
        targets.push(target);
    }
    Ok(targets)
}

/// An ephemeral identifier-only wake hint for a durable delivery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowDeliveryWake {
    /// Managed-agent recipient of this hint.
    pub target_pubkey: PublicKey,
    /// Identifier of the durable delivery to look up.
    pub delivery_id: WorkflowDeliveryId,
}

impl WorkflowDeliveryWake {
    /// Construct a wake hint.
    pub const fn new(target_pubkey: PublicKey, delivery_id: WorkflowDeliveryId) -> Self {
        Self {
            target_pubkey,
            delivery_id,
        }
    }

    /// Build the unsigned, identifier-only kind-24620 wake event.
    pub fn event_builder(&self) -> Result<EventBuilder, WorkflowDeliveryError> {
        Ok(
            EventBuilder::new(Kind::Custom(KIND_WORKFLOW_AGENT_WAKE as u16), "").tags([
                parse_tag(["p", &self.target_pubkey.to_hex()])?,
                parse_tag([WORKFLOW_DELIVERY_WAKE_TAG, &self.delivery_id.to_string()])?,
            ]),
        )
    }

    /// Parse a strictly canonical identifier-only wake event.
    pub fn parse(event: &Event) -> Result<Self, WorkflowDeliveryError> {
        if event.kind.as_u16() != KIND_WORKFLOW_AGENT_WAKE as u16 {
            return Err(WorkflowDeliveryError::WrongWakeKind(event.kind.as_u16()));
        }
        if !event.content.is_empty() {
            return Err(WorkflowDeliveryError::WakeHasContent);
        }
        let mut target = None;
        let mut delivery = None;
        for tag in event.tags.iter() {
            let values = tag.as_slice();
            match values.first().map(String::as_str) {
                Some("p") if values.len() == 2 => {
                    if target.replace(parse_pubkey(&values[1])?).is_some() {
                        return Err(WorkflowDeliveryError::DuplicateWakeTag("p"));
                    }
                }
                Some(WORKFLOW_DELIVERY_WAKE_TAG) if values.len() == 2 => {
                    let id = Uuid::parse_str(&values[1])
                        .map(WorkflowDeliveryId::from_uuid)
                        .map_err(|_| WorkflowDeliveryError::InvalidDeliveryId)?;
                    if delivery.replace(id).is_some() {
                        return Err(WorkflowDeliveryError::DuplicateWakeTag(
                            WORKFLOW_DELIVERY_WAKE_TAG,
                        ));
                    }
                }
                _ => return Err(WorkflowDeliveryError::UnexpectedWakeTag),
            }
        }
        Ok(Self {
            target_pubkey: target.ok_or(WorkflowDeliveryError::MissingWakeTag("p"))?,
            delivery_id: delivery.ok_or(WorkflowDeliveryError::MissingWakeTag(
                WORKFLOW_DELIVERY_WAKE_TAG,
            ))?,
        })
    }
}

/// Canonical failures while constructing or parsing delivery protocol values.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum WorkflowDeliveryError {
    /// A workflow step identity was blank or whitespace only.
    #[error("workflow delivery step_id must not be empty")]
    EmptyStepId,
    /// A visible message was not kind 9.
    #[error("workflow delivery message must be kind 9, got {0}")]
    WrongMessageKind(u16),
    /// A visible message did not match its binding's signed event ID.
    #[error("workflow delivery message event ID does not match binding")]
    MessageEventIdMismatch,
    /// A binding target was absent from the visible message's `message-v1` tags.
    #[error("workflow delivery message has no matching message-v1 target")]
    MissingMessageV1Target,
    /// A `message-v1` tag did not use the canonical four-field p-tag grammar.
    #[error("workflow delivery message has malformed message-v1 target tag")]
    InvalidMessageV1Tag,
    /// A `message-v1` recipient appeared more than once.
    #[error("workflow delivery message has duplicate message-v1 target")]
    DuplicateMessageV1Target,
    /// A wake was not kind 24620.
    #[error("workflow delivery wake must be kind 24620, got {0}")]
    WrongWakeKind(u16),
    /// A wake carried non-empty content.
    #[error("workflow delivery wake content must be empty")]
    WakeHasContent,
    /// A required wake tag was absent.
    #[error("workflow delivery wake is missing {0} tag")]
    MissingWakeTag(&'static str),
    /// A required wake tag occurred more than once.
    #[error("workflow delivery wake has duplicate {0} tag")]
    DuplicateWakeTag(&'static str),
    /// A wake tag did not belong to the identifier-only grammar.
    #[error("workflow delivery wake has an unexpected tag")]
    UnexpectedWakeTag,
    /// The delivery tag did not carry a UUID.
    #[error("workflow delivery wake delivery tag must contain a UUID")]
    InvalidDeliveryId,
    /// A public key was malformed.
    #[error("workflow delivery public key is invalid")]
    InvalidPublicKey,
    /// Nostr rejected construction of a protocol tag.
    #[error("workflow delivery tag is invalid: {0}")]
    InvalidTag(String),
}

fn parse_tag<const N: usize>(values: [&str; N]) -> Result<Tag, WorkflowDeliveryError> {
    Tag::parse(values).map_err(|error| WorkflowDeliveryError::InvalidTag(error.to_string()))
}

fn parse_pubkey(value: &str) -> Result<PublicKey, WorkflowDeliveryError> {
    PublicKey::from_hex(value).map_err(|_| WorkflowDeliveryError::InvalidPublicKey)
}

#[cfg(test)]
mod tests {
    use nostr::Keys;

    use super::*;

    fn binding() -> WorkflowDeliveryBinding {
        let keys = Keys::generate();
        WorkflowDeliveryBinding::new(
            CommunityId::from_uuid(Uuid::new_v4()),
            Uuid::new_v4(),
            Uuid::new_v4(),
            "notify",
            keys.public_key(),
            EventId::from_hex(&"11".repeat(32)).unwrap(),
            EventId::from_hex(&"22".repeat(32)).unwrap(),
            WorkflowDeliveryCause::Event(EventId::from_hex(&"33".repeat(32)).unwrap()),
        )
        .unwrap()
    }

    #[test]
    fn binding_owns_all_identity_fields_and_rejects_blank_step() {
        let binding = binding();
        assert_eq!(binding.step_id, "notify");
        assert!(matches!(binding.cause, WorkflowDeliveryCause::Event(_)));
        assert_eq!(
            WorkflowDeliveryBinding::new(
                binding.community_id,
                binding.workflow_id,
                binding.run_id,
                " \t",
                binding.target_pubkey,
                binding.definition_event_id,
                binding.message_event_id,
                binding.cause.clone(),
            ),
            Err(WorkflowDeliveryError::EmptyStepId)
        );
    }

    #[test]
    fn message_v1_tags_are_canonical_and_target_specific() {
        let binding = binding();
        let tag = binding.message_v1_target_tag().unwrap();
        assert_eq!(
            tag.as_slice(),
            [
                "p",
                &binding.target_pubkey.to_hex(),
                "",
                WORKFLOW_DELIVERY_TARGET_MARKER
            ]
        );
    }

    #[test]
    fn cause_variants_and_each_identity_field_affect_equality() {
        let binding = binding();
        let event = WorkflowDeliveryCause::Event(EventId::from_hex(&"44".repeat(32)).unwrap());
        let schedule = WorkflowDeliveryCause::Schedule {
            scheduled_for_unix_seconds: 1,
        };
        let later_schedule = WorkflowDeliveryCause::Schedule {
            scheduled_for_unix_seconds: 2,
        };
        let webhook = WorkflowDeliveryCause::Webhook {
            invocation_id: Uuid::new_v4(),
        };
        let other_webhook = WorkflowDeliveryCause::Webhook {
            invocation_id: Uuid::new_v4(),
        };
        assert_ne!(binding.cause, event);
        assert_ne!(schedule, later_schedule);
        assert_ne!(webhook, other_webhook);
    }

    #[test]
    fn message_v1_parser_and_binding_validation_fail_closed() {
        let binding = binding();
        let event = EventBuilder::new(Kind::Custom(9), "visible")
            .tags([binding.message_v1_target_tag().unwrap()])
            .sign_with_keys(&Keys::generate())
            .unwrap();
        let matching = WorkflowDeliveryBinding::new(
            binding.community_id,
            binding.workflow_id,
            binding.run_id,
            binding.step_id.clone(),
            binding.target_pubkey,
            binding.definition_event_id,
            event.id,
            binding.cause.clone(),
        )
        .unwrap();
        assert_eq!(
            message_v1_targets(&event).unwrap(),
            vec![binding.target_pubkey]
        );
        assert!(matching.validate_message_event(&event).is_ok());

        let malformed = EventBuilder::new(Kind::Custom(9), "visible")
            .tags([parse_tag([
                "p",
                &binding.target_pubkey.to_hex(),
                "",
                WORKFLOW_DELIVERY_TARGET_MARKER,
                "extra",
            ])
            .unwrap()])
            .sign_with_keys(&Keys::generate())
            .unwrap();
        assert_eq!(
            message_v1_targets(&malformed),
            Err(WorkflowDeliveryError::InvalidMessageV1Tag)
        );
    }

    #[test]
    fn wake_round_trips_and_contains_no_authority_beyond_identifier_and_target() {
        let target = Keys::generate().public_key();
        let wake = WorkflowDeliveryWake::new(target, WorkflowDeliveryId::from_uuid(Uuid::new_v4()));
        let event = wake
            .event_builder()
            .unwrap()
            .sign_with_keys(&Keys::generate())
            .unwrap();
        assert_eq!(event.kind.as_u16(), KIND_WORKFLOW_AGENT_WAKE as u16);
        assert!(event.content.is_empty());
        assert_eq!(event.tags.len(), 2);
        assert_eq!(WorkflowDeliveryWake::parse(&event).unwrap(), wake);
    }

    #[test]
    fn wake_rejects_extra_or_duplicate_or_noncanonical_fields() {
        let target = Keys::generate().public_key().to_hex();
        let id = Uuid::new_v4().to_string();
        let event = EventBuilder::new(Kind::Custom(KIND_WORKFLOW_AGENT_WAKE as u16), "x")
            .tags([
                parse_tag(["p", &target]).unwrap(),
                parse_tag(["delivery", &id]).unwrap(),
            ])
            .sign_with_keys(&Keys::generate())
            .unwrap();
        assert_eq!(
            WorkflowDeliveryWake::parse(&event),
            Err(WorkflowDeliveryError::WakeHasContent)
        );

        let event = EventBuilder::new(Kind::Custom(KIND_WORKFLOW_AGENT_WAKE as u16), "")
            .tags([
                parse_tag(["p", &target]).unwrap(),
                parse_tag(["delivery", &id]).unwrap(),
                parse_tag(["e", "x"]).unwrap(),
            ])
            .sign_with_keys(&Keys::generate())
            .unwrap();
        assert_eq!(
            WorkflowDeliveryWake::parse(&event),
            Err(WorkflowDeliveryError::UnexpectedWakeTag)
        );
    }
}
