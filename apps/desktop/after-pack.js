const { flipFuses, FuseVersion, FuseV1Options } = require("@electron/fuses");

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName;
  const productName = context.packager.appInfo.productFilename;
  const electronBinary = platform === "darwin"
    ? `${context.appOutDir}/${productName}.app/Contents/MacOS/${productName}`
    : `${context.appOutDir}/${productName}.exe`;

  await flipFuses(electronBinary, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });
};
