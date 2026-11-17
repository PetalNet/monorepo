// swift-tools-version: 5.9
import PackageDescription

let package = Package(
	name: "janet-dictate",
	platforms: [.macOS("26.0")],
	products: [
		.executable(name: "janet-dictate", targets: ["JanetDictate"]),
	],
	targets: [
		.target(name: "DictateCore"),
		.executableTarget(
			name: "JanetDictate",
			dependencies: ["DictateCore"]
		),
		.testTarget(
			name: "DictateCoreTests",
			dependencies: ["DictateCore"]
		),
	]
)
