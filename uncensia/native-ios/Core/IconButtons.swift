import SwiftUI

// Icons are SF Symbols, so they follow Dynamic Type, weight and accessibility like the rest of the system.

extension View {
    /// Text scrolled under the navigation bar must not collide with the title:
    /// iOS 26 draws a hard scroll edge, earlier releases a solid bar.
    @ViewBuilder func readableUnderNavigationBar() -> some View {
        if #available(iOS 26, *) {
            scrollEdgeEffectStyle(.hard, for: .top)
        } else {
            toolbarBackground(.visible, for: .navigationBar)
        }
    }
}
