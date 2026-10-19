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
        // Ydin äpin sisällä (S-8a): XCFramework tulee portista (T-46, ydin/apple/rakenna-xcframework.sh).
        .binaryTarget(name: "ScopesSolmu", path: "../../ydin/apple/ScopesSolmu.xcframework"),
        .target(
            name: "ScopesCore2",
            dependencies: ["ScopesSolmu"],
            linkerSettings: [
                .linkedFramework("Security"),
                .linkedFramework("SystemConfiguration"),
                .linkedLibrary("resolv")
            ]
        ),
        .testTarget(
            name: "ScopesCore2Tests",
            dependencies: ["ScopesCore2"],
            resources: [.copy("fixture")]
        )
    ]
)
