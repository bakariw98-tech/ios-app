import SwiftUI

/// Step 8 — how it went.
///
/// The prose summary leads, because that's what someone waiting to hear how a
/// hard conversation went actually wants. The structured detail sits below it
/// for anyone who wants specifics.
struct SummaryView: View {
    let callId: String
    let client: BackendClient

    @State private var summary: CallSummary?
    @State private var stillAnalysing = true

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                if let summary {
                    Text(summary.summary)
                        .font(.body)
                        .fixedSize(horizontal: false, vertical: true)

                    if let data = summary.structuredData {
                        detail(data)
                    }
                } else if stillAnalysing {
                    VStack(spacing: 12) {
                        ProgressView()
                        Text("Putting together how it went…")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 60)
                }
            }
            .padding(24)
        }
        .navigationTitle("How it went")
        .navigationBarTitleDisplayMode(.inline)
        .task { await poll() }
    }

    @ViewBuilder
    private func detail(_ data: CallSummary.StructuredData) -> some View {
        if let goal = data.goalAchieved {
            Label(
                goal ? "They heard you" : "It didn't land the way you hoped",
                systemImage: goal ? "checkmark.circle.fill" : "circle.slash"
            )
            .font(.subheadline.weight(.medium))
            .foregroundStyle(goal ? .green : .secondary)
        }

        if let points = data.pointsCommunicated, !points.isEmpty {
            section("What I said") {
                ForEach(points, id: \.self) { Text("• \($0)").font(.subheadline) }
            }
        }

        if let missed = data.pointsNotCommunicated, !missed.isEmpty {
            section("What I didn't get to") {
                ForEach(missed, id: \.self) {
                    Text("• \($0)").font(.subheadline).foregroundStyle(.secondary)
                }
            }
        }

        if let answers = data.questionsAnswered, !answers.isEmpty {
            section("What they said") {
                ForEach(answers) { qa in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(qa.question).font(.subheadline.weight(.medium))
                        Text(qa.answer).font(.subheadline).foregroundStyle(.secondary)
                    }
                }
            }
        }

        if let followUp = data.followUpNeeded, !followUp.isEmpty {
            section("Worth following up") { Text(followUp).font(.subheadline) }
        }
    }

    @ViewBuilder
    private func section(
        _ title: String,
        @ViewBuilder content: () -> some View
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            content()
        }
    }

    /// Analysis lands a few seconds after hangup; give it a bounded window.
    private func poll() async {
        for _ in 0..<20 {
            if let fetched = try? await client.summary(callId: callId), let fetched {
                summary = fetched
                stillAnalysing = false
                return
            }
            try? await Task.sleep(for: .seconds(3))
        }
        stillAnalysing = false
    }
}
