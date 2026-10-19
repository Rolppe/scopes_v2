// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ScopesCore2",
    platforms: [
        .macOS(.v14),
        .iOS("18.0")
    ],
    products: [
        .library(name: "ScopesCore2", targets: ["ScopesCore2"])
    ],
    dependencies: [],
    targets: [
        .target(name: "ScopesCore2", dependencies: []),
        .testTarget(name: "ScopesCore2Tests", dependencies: ["ScopesCore2"])
    ]
)
