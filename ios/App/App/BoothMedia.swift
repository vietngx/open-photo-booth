import Capacitor
import UIKit

final class BoothViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(BoothMedia())
    }
}

@objc(BoothMedia)
final class BoothMedia: CAPPlugin, CAPBridgedPlugin, UIPrintInteractionControllerDelegate {
    let identifier = "BoothMedia"
    let jsName = "BoothMedia"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "savePhoto", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "printPhoto", returnType: CAPPluginReturnPromise)
    ]

    private let files = FileManager.default
    private var paperSize: CGSize?

    private func photoURL(event: String, name: String) throws -> URL {
        let documents = try files.url(for: .documentDirectory, in: .userDomainMask,
                                      appropriateFor: nil, create: true).resolvingSymlinksInPath()
        let directory = documents.appendingPathComponent(event, isDirectory: true)
        let photo = directory.appendingPathComponent(name)
        guard directory.resolvingSymlinksInPath().path == directory.path,
              photo.resolvingSymlinksInPath().path == photo.path,
              !event.isEmpty, event != ".", event != "..", !event.contains("/"),
              name == photo.lastPathComponent, photo.pathExtension.lowercased() == "jpg" else {
            throw CocoaError(.fileReadInvalidFileName)
        }
        return photo
    }

    @objc func savePhoto(_ call: CAPPluginCall) {
        guard let name = call.getString("name"), let encoded = call.getString("data"),
              let data = Data(base64Encoded: encoded), data.starts(with: [0xff, 0xd8, 0xff]) else {
            return call.reject("Invalid JPEG photo.")
        }
        let unsafe = CharacterSet(charactersIn: "/\\:*?\"<>|").union(.controlCharacters)
        let raw = call.getString("eventName") ?? ""
        let event = raw.components(separatedBy: unsafe).joined(separator: "_")
            .trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: ".")))
        do {
            let folder = event.isEmpty ? "Event" : event
            var photo = try photoURL(event: folder, name: name)
            let directory = photo.deletingLastPathComponent()
            try files.createDirectory(at: directory, withIntermediateDirectories: true)
            if files.fileExists(atPath: photo.path) {
                let stem = photo.deletingPathExtension().lastPathComponent
                photo = directory.appendingPathComponent("\(stem)-\(UUID().uuidString).jpg")
            }
            try data.write(to: photo, options: .atomic)
            call.resolve(["file": "\(folder)/\(photo.lastPathComponent)"])
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    @objc func printPhoto(_ call: CAPPluginCall) {
        let parts = (call.getString("file") ?? "").components(separatedBy: "/")
        guard parts.count == 2, let photo = try? photoURL(event: parts[0], name: parts[1]),
              let image = UIImage(contentsOfFile: photo.path),
              let width = call.getDouble("widthIn"), let height = call.getDouble("heightIn"),
              width.isFinite, height.isFinite, width > 0, height > 0 else {
            return call.reject("Invalid booth photo or print size.")
        }
        DispatchQueue.main.async {
            guard self.paperSize == nil, UIPrintInteractionController.isPrintingAvailable,
                  let view = self.bridge?.viewController?.view, view.window != nil else {
                return call.reject("The print dialog is unavailable.")
            }
            self.paperSize = CGSize(width: width * 72, height: height * 72)
            let controller = UIPrintInteractionController.shared
            let info = UIPrintInfo(dictionary: nil)
            info.jobName = photo.lastPathComponent
            info.outputType = .photo
            info.orientation = width > height ? .landscape : .portrait
            controller.printInfo = info
            controller.printPageRenderer = PhotoPage(image)
            controller.delegate = self
            let completion: UIPrintInteractionController.CompletionHandler = { _, completed, error in
                self.paperSize = nil
                controller.printPageRenderer = nil
                if let error = error { call.reject(error.localizedDescription) }
                else { call.resolve(["cancelled": !completed]) }
            }
            let anchor = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
            let shown = UIDevice.current.userInterfaceIdiom == .pad
                ? controller.present(from: anchor, in: view, animated: true, completionHandler: completion)
                : controller.present(animated: true, completionHandler: completion)
            if !shown {
                self.paperSize = nil
                controller.printPageRenderer = nil
                call.reject("Could not open the print dialog.")
            }
        }
    }

    func printInteractionController(_ controller: UIPrintInteractionController,
                                    choosePaper papers: [UIPrintPaper]) -> UIPrintPaper {
        UIPrintPaper.bestPaper(forPageSize: paperSize ?? .zero, withPapersFrom: papers)
    }
}

private final class PhotoPage: UIPrintPageRenderer {
    private let photo: UIImage
    init(_ photo: UIImage) {
        self.photo = photo
        super.init()
    }
    override var numberOfPages: Int { 1 }

    override func drawContentForPage(at pageIndex: Int, in rect: CGRect) {
        let scale = min(rect.width / photo.size.width, rect.height / photo.size.height)
        let width = photo.size.width * scale, height = photo.size.height * scale
        photo.draw(in: CGRect(x: rect.midX - width / 2, y: rect.midY - height / 2,
                              width: width, height: height))
    }
}
