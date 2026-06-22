const OPTION_ALIASES = new Map([
  ["--crema", "crema"],
  ["--advanced-chords", "crema"],
  ["--beat-this", "beatThis"],
  ["--advanced-beats", "beatThis"],
  ["--legacy-nvidia", "legacyNvidia"],
  ["--model-bundle", "modelBundle"],
  ["--no-bundle", "noBundle"],
  ["--sandbox-data", "sandboxData"],
]);

export function defaultPackageOptions() {
  return {
    crema: false,
    beatThis: false,
    legacyNvidia: false,
    modelBundle: false,
    noBundle: false,
    sandboxData: false,
  };
}

export function parsePackageOptions(argv, { platform } = {}) {
  const options = defaultPackageOptions();
  for (const arg of argv) {
    if (arg === "--") {
      continue;
    }
    const optionName = OPTION_ALIASES.get(arg);
    if (!optionName) {
      throw new Error(`Unknown option: ${arg}`);
    }
    options[optionName] = true;
  }
  return validatePackageOptions(options, { platform });
}

export function packageOptionsFromEnvironmentOrArgv(argv, { platform } = {}) {
  const encodedOptions = process.env.TUNEFORGE_PACKAGE_OPTIONS;
  if (!encodedOptions) {
    return parsePackageOptions(argv, { platform });
  }
  return validatePackageOptions(JSON.parse(encodedOptions), { platform });
}

export function validatePackageOptions(rawOptions, { platform } = {}) {
  const options = { ...defaultPackageOptions(), ...rawOptions };
  if (platform === "mac" && options.legacyNvidia) {
    throw new Error("--legacy-nvidia is only supported for Linux packaging.");
  }
  if (platform === "mac" && options.noBundle) {
    throw new Error("--no-bundle is only supported for Linux Flatpak packaging.");
  }
  if (platform === "mac" && options.sandboxData) {
    throw new Error("--sandbox-data is only supported for Linux Flatpak packaging.");
  }
  return {
    crema: Boolean(options.crema),
    beatThis: Boolean(options.beatThis),
    legacyNvidia: Boolean(options.legacyNvidia),
    modelBundle: Boolean(options.modelBundle),
    noBundle: Boolean(options.noBundle),
    sandboxData: Boolean(options.sandboxData),
  };
}

export function packageOptionsEnvironment(options) {
  return {
    TUNEFORGE_PACKAGE_OPTIONS: JSON.stringify(validatePackageOptions(options)),
  };
}

export function packageOptionsToGeneratorArgs(options) {
  const validated = validatePackageOptions(options);
  const args = [];
  if (validated.crema) {
    args.push("--crema");
  }
  if (validated.beatThis) {
    args.push("--beat-this");
  }
  if (validated.legacyNvidia) {
    args.push("--legacy-nvidia");
  }
  if (validated.modelBundle) {
    args.push("--model-bundle");
  }
  return args;
}

export function backendSyncArgs(options) {
  const validated = validatePackageOptions(options);
  const args = ["sync", "--python", "3.11", "--all-groups"];
  if (validated.crema) {
    args.push("--extra", "advanced-chords");
  }
  if (validated.beatThis) {
    args.push("--extra", "advanced-beats");
  }
  return args;
}

export function printModelBundleWarning({ stream = process.stderr } = {}) {
  stream.write(
    "Warning: --model-bundle redistributes external ML model weights. " +
      "Demucs pretrained weight redistribution is unclear/restricted upstream; " +
      "use this only for explicit local/dev packaging.\n",
  );
}
