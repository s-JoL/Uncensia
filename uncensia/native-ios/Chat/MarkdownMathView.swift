import SwiftMath
import SwiftUI

/// SwiftMath 1.7.3 uses CoreText with bundled math fonts; no web process or
/// network request participates in transcript layout. See the bundled license.
@MainActor enum NativeMathCache {
  final class Rendered: NSObject {
    let image: UIImage
    let descent: CGFloat
    init(image: UIImage, descent: CGFloat) { self.image = image; self.descent = descent }
  }
  private static let cache: NSCache<NSString, Rendered> = {
    let value = NSCache<NSString, Rendered>(); value.totalCostLimit = 12 * 1024 * 1024; value.countLimit = 200; return value
  }()
  static func render(_ latex: String, display: Bool, fontSize: CGFloat, dark: Bool, scale: CGFloat) -> Rendered? {
    let key = "\(latex)|\(display)|\(fontSize)|\(dark)|\(scale)" as NSString
    if let result = cache.object(forKey: key) { return result }
    let label = MTMathUILabel()
    label.displayErrorInline = false
    label.labelMode = display ? .display : .text
    label.fontSize = fontSize
    label.textColor = UIColor.label.resolvedColor(with: .init(userInterfaceStyle: dark ? .dark : .light))
    label.latex = latex
    guard label.error == nil else { return nil }
    let size = label.intrinsicContentSize
    guard size.width.isFinite, size.height.isFinite, size.width > 0, size.height > 0,
      size.width * scale < 8192, size.height * scale < 8192,
      size.width * size.height * scale * scale < 4_000_000 else { return nil }
    let canvas = CGSize(width: ceil(size.width) + 2, height: ceil(size.height) + 2)
    label.frame = CGRect(origin: .zero, size: canvas)
    label.layoutIfNeeded()
    guard let displayList = label.displayList else { return nil }
    let format = UIGraphicsImageRendererFormat(); format.scale = scale; format.opaque = false
    let image = UIGraphicsImageRenderer(size: canvas, format: format).image { renderer in
      // SwiftMath lays out CoreText in a bottom-left coordinate system. UIKit
      // images use top-left coordinates; snapshotting its flipped CALayer
      // without this conversion turns every glyph and fraction upside down.
      let context = renderer.cgContext
      context.translateBy(x: 0, y: canvas.height)
      context.scaleBy(x: 1, y: -1)
      displayList.draw(context)
    }
    let result = Rendered(image: image, descent: displayList.descent + 1)
    cache.setObject(result, forKey: key, cost: (image.cgImage?.bytesPerRow ?? 0) * (image.cgImage?.height ?? 0))
    return result
  }
}

struct MarkdownMathView: View {
  let latex: String
  var pending = false
  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.displayScale) private var scale
  @ScaledMetric(relativeTo: .body) private var fontSize: CGFloat = 20
  var body: some View {
    ScrollView(.horizontal) {
      Group {
        if pending {
          ProgressView().controlSize(.small).accessibilityLabel(uncensiaText("正在回复"))
        } else if let rendered = NativeMathCache.render(latex, display: true, fontSize: fontSize, dark: colorScheme == .dark, scale: scale) {
          Image(uiImage: rendered.image).fixedSize().accessibilityLabel(latex)
        } else {
          Text(latex).font(.body.monospaced()).textSelection(.enabled)
        }
      }.padding(.vertical, 8).frame(minHeight: 64)
    }
    .accessibilityIdentifier("chat.math")
    .contextMenu { Button(uncensiaText("复制"), systemImage: "doc.on.doc") { UIPasteboard.general.string = latex } }
  }
}
