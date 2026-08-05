import Foundation

/// Phases mirror `CallPhase` in the backend store.
enum CallPhase: String, Codable {
    case interviewing
    case awaitingRecipient = "awaiting_recipient"
    case delegating
    case ended
    case blocked
}

struct SessionStart: Codable {
    let phoneNumber: String
    let instructions: Instructions

    struct Instructions: Codable {
        let before: String
        let merge: String
    }
}

struct CallStatus: Codable {
    let callId: String
    let phase: CallPhase
    let startedAt: String
    let endedAt: String?
    let blockedCategory: String?
    let hasSummary: Bool
}

struct TranscriptLine: Codable, Identifiable, Hashable {
    let role: String
    let text: String
    let at: String

    var id: String { "\(at)-\(role)" }
    var isAssistant: Bool { role == "assistant" }
}

struct CallSummary: Codable {
    let summary: String
    let structuredData: StructuredData?
    let successEvaluation: String?

    struct StructuredData: Codable {
        let pointsCommunicated: [String]?
        let pointsNotCommunicated: [String]?
        let questionsAnswered: [QA]?
        let recipientReaction: String?
        let goalAchieved: Bool?
        let boundariesRespected: Bool?
        let followUpNeeded: String?

        struct QA: Codable, Identifiable {
            let question: String
            let answer: String
            var id: String { question }
        }
    }
}
