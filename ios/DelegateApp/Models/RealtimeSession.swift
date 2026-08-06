import Foundation

/// What the backend hands back from `POST /realtime/session`.
///
/// `clientSecret` is a short-lived OpenAI credential scoped to exactly one
/// Realtime session — never the real API key, which never leaves the
/// backend. See backend/src/lib/openaiRealtime.ts.
struct RealtimeSessionInfo: Codable {
    let clientSecret: String
    let expiresAt: String
    let model: String
    let voice: String
}

/// The brief the user gives before the AI starts talking. Mirrors
/// backend/src/domain/inPersonBrief.ts's `BriefSchema` — keep the two in sync.
struct Brief: Codable {
    let situation: String
    var userFirstName: String?
    var voice: String?
}
