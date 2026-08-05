import SwiftUI

/// Reference copy for the merge step.
///
/// The app cannot perform the merge — there's no CallKit API for it (ADR-001).
/// In practice the assistant coaches this out loud, one step at a time, which
/// works better than a screen nobody is looking at mid-call. This view exists
/// so the user can see the shape of it beforehand and glance back if they lose
/// the thread; it is not the primary teaching surface.
///
/// The last line matters most: it tells the user they don't have to explain the
/// AI themselves. The assistant handles the introduction, and it does so
/// automatically as soon as it hears someone new (ADR-004).
struct MergeGuideView: View {
    let instruction: String

    private let steps: [(symbol: String, title: String, detail: String)] = [
        (
            "plus.circle.fill",
            "Tap **Add Call**",
            "I'll still be here — you won't lose me."
        ),
        (
            "phone.fill",
            "Dial them",
            "Wait until they pick up."
        ),
        (
            "arrow.triangle.merge",
            "Tap **Merge Calls**",
            "That's it — I'll hear them and introduce myself."
        ),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("When you're ready to bring them on")
                .font(.headline)

            ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                HStack(alignment: .top, spacing: 14) {
                    Image(systemName: step.symbol)
                        .font(.title3)
                        .foregroundStyle(.tint)
                        .frame(width: 28)
                        .accessibilityHidden(true)

                    VStack(alignment: .leading, spacing: 3) {
                        Text(.init(step.title))
                            .font(.subheadline.weight(.medium))
                        Text(step.detail)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Step \(index + 1). \(step.title.replacingOccurrences(of: "**", with: "")). \(step.detail)")
            }

            Divider()

            Label {
                Text("The moment I hear them, I tell them I'm an AI speaking for you and ask if they're okay to continue — before anything else. You don't have to explain me.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } icon: {
                Image(systemName: "checkmark.shield.fill")
                    .foregroundStyle(.secondary)
            }
        }
        .padding(22)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 20))
    }
}
