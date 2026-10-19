// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ScopesUI2",
    platforms: [
        .macOS(.v14),
        .iOS("18.0")
    ],
    products: [
        .library(name: "ScopesUI2", targets: ["ScopesUI2"])
    ],
    dependencies: [
        .package(path: "../ScopesCore2")
    ],
    targets: [
        .target(name: "ScopesUI2", dependencies: [.product(name: "ScopesCore2", package: "ScopesCore2")]),
        .testTarget(name: "ScopesUI2Tests", dependencies: ["ScopesUI2"])
    ]
)
