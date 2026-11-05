const { AndroidConfig, withAndroidManifest } = require("expo/config-plugins");

// ProcessTextActivity (modules/t3-android-intents) reads this to build prompt
// links for the variant's own scheme.
const APP_LINK_SCHEME_KEY = "com.t3tools.APP_LINK_SCHEME";

module.exports = function withAndroidAppLinkScheme(config) {
  return withAndroidManifest(config, (nextConfig) => {
    const scheme = Array.isArray(nextConfig.scheme) ? nextConfig.scheme[0] : nextConfig.scheme;
    if (typeof scheme !== "string" || scheme.length === 0) {
      throw new Error("withAndroidAppLinkScheme: the Expo config has no scheme.");
    }
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(nextConfig.modResults);
    AndroidConfig.Manifest.addMetaDataItemToMainApplication(
      application,
      APP_LINK_SCHEME_KEY,
      scheme,
    );
    return nextConfig;
  });
};
