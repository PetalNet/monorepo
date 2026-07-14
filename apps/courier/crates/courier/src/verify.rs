//! Emoji SAS verification handlers.
//!
//! Accepts incoming verification requests (to-device and in-room) and, when
//! `auto_verify` is set, auto-confirms once emojis are exchanged.

use core::time::Duration;

use futures_util::StreamExt as _;
use matrix_sdk::{
    Client,
    encryption::verification::{
        SasState, SasVerification, Verification, VerificationRequest, VerificationRequestState,
    },
    ruma::events::{
        key::verification::{
            request::ToDeviceKeyVerificationRequestEvent, start::ToDeviceKeyVerificationStartEvent,
        },
        room::message::{MessageType, OriginalSyncRoomMessageEvent},
    },
};
use tracing::{debug, info, warn};

/// Install all verification handlers on `client`.
pub fn install(client: &Client, auto_confirm: bool) {
    client.add_event_handler(
        async move |ev: ToDeviceKeyVerificationRequestEvent, client: Client| {
            info!(user = %ev.sender, flow = %ev.content.transaction_id, "Received verification request");
            let sender = ev.sender.clone();
            let flow_id = ev.content.transaction_id.to_string();
            tokio::spawn(async move {
                if let Some(req) =
                    get_verification_request_with_retry(&client, &sender, &flow_id).await
                {
                    handle_verification_request(req, auto_confirm).await;
                } else {
                    warn!(user = %sender, flow = %flow_id, "No verification request found after retry");
                }
            });
        },
    );

    client.add_event_handler(
        async move |ev: OriginalSyncRoomMessageEvent, client: Client| {
            if let MessageType::VerificationRequest(_) = &ev.content.msgtype {
                info!(user = %ev.sender, event = %ev.event_id, "Received in-room verification request");
                let sender = ev.sender.clone();
                let flow_id = ev.event_id.to_string();
                tokio::spawn(async move {
                    if let Some(req) =
                        get_verification_request_with_retry(&client, &sender, &flow_id).await
                    {
                        handle_verification_request(req, auto_confirm).await;
                    } else {
                        warn!(user = %sender, flow = %flow_id, "In-room verification request not found after retry");
                    }
                });
            }
        },
    );

    client.add_event_handler(
        async move |ev: ToDeviceKeyVerificationStartEvent, client: Client| {
            info!(user = %ev.sender, flow = %ev.content.transaction_id, "Received verification start");
            if let Some(Verification::SasV1(sas)) = client
                .encryption()
                .get_verification(&ev.sender, ev.content.transaction_id.as_str())
                .await
            {
                tokio::spawn(handle_sas(sas, auto_confirm));
            }
        },
    );
}

async fn handle_verification_request(request: VerificationRequest, auto_confirm: bool) {
    info!(user = %request.other_user_id(), "Accepting verification request");
    if let Err(e) = request.accept().await {
        warn!(error = %e, "Failed to accept verification request");
        return;
    }
    let mut stream = request.changes();
    while let Some(state) = stream.next().await {
        match state {
            VerificationRequestState::Transitioned { verification } => {
                if let Some(sas) = verification.sas() {
                    tokio::spawn(handle_sas(sas, auto_confirm));
                }
                break;
            }
            VerificationRequestState::Cancelled(info) => {
                warn!(reason = %info.reason(), "Verification cancelled (request stage)");
                break;
            }
            VerificationRequestState::Done => {
                info!("Verification already done at request stage");
                break;
            }
            VerificationRequestState::Created { .. }
            | VerificationRequestState::Requested { .. }
            | VerificationRequestState::Ready { .. } => {}
        }
    }
}

async fn get_verification_request_with_retry(
    client: &Client,
    user_id: &matrix_sdk::ruma::OwnedUserId,
    flow_id: &str,
) -> Option<VerificationRequest> {
    // The request can race event delivery; retry briefly before giving up.
    const ATTEMPTS: usize = 25;
    const SLEEP_MS: u64 = 200;
    for _ in 0..ATTEMPTS {
        if let Some(req) = client
            .encryption()
            .get_verification_request(user_id, flow_id)
            .await
        {
            return Some(req);
        }
        tokio::time::sleep(Duration::from_millis(SLEEP_MS)).await;
    }
    None
}

async fn handle_sas(sas: SasVerification, auto_confirm: bool) {
    info!(
        user = %sas.other_device().user_id(),
        device = %sas.other_device().device_id(),
        "Starting SAS verification"
    );
    if let Err(e) = sas.accept().await {
        warn!(error = %e, "Failed to accept SAS");
        return;
    }

    let mut stream = sas.changes();
    while let Some(state) = stream.next().await {
        match state.clone() {
            SasState::KeysExchanged {
                emojis: Some(e), ..
            } => {
                let emoji_string = e
                    .emojis
                    .iter()
                    .map(|em| em.symbol)
                    .collect::<Vec<_>>()
                    .join(" ");
                let descriptions = e
                    .emojis
                    .iter()
                    .map(|em| em.description)
                    .collect::<Vec<_>>()
                    .join(" ");
                debug!("SAS emojis: {emoji_string}\nSAS names:  {descriptions}");
                if auto_confirm && let Err(e) = sas.confirm().await {
                    warn!(error = %e, "Failed to confirm SAS");
                }
            }
            SasState::Done { .. } => {
                info!("Verification completed");
                break;
            }
            SasState::Cancelled(info) => {
                warn!(reason = %info.reason(), "Verification cancelled (SAS stage)");
                break;
            }
            SasState::Created { .. }
            | SasState::Started { .. }
            | SasState::Accepted { .. }
            | SasState::KeysExchanged { .. }
            | SasState::Confirmed => {}
        }
    }
}
