const OPTION_ALIASES = new Map([
  ["--crema", ["crema", true]],
  ["--advanced-chords", ["crema", true]],
  ["--no-crema", ["crema", false]],
  ["--no-advanced-chords", ["crema", false]],
  ["--lv-chordia", ["lvChordia", true]],
  ["--no-lv-chordia", ["lvChordia", false]],
  ["--beat-this", ["beatThis", true]],
  ["--advanced-beats", ["beatThis", true]],
  ["--no-beat-this", ["beatThis", false]],
  ["--no-advanced-beats", ["beatThis", false]],
  ["--legacy-nvidia", ["legacyNvidia", true]],
  ["--model-bundle", ["modelBundle", true]],
  ["--no-bundle", ["noBundle", true]],
  ["--sandbox-data", ["sandboxData", true]],
]);

export function defaultPackageOptions() {
  return {
    crema: true,
    lvChordia: true,
    beatThis: true,
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
    const option = OPTION_ALIASES.get(arg);
    if (!option) {
      throw new Error(`Unknown option: ${arg}`);
    }
    const [optionName, value] = option;
    options[optionName] = value;
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
  if (options.legacyNvidia && options.lvChordia) {
    throw new Error("--legacy-nvidia requires --no-lv-chordia because LV Chordia is audited only with Torch 2.11.0.");
  }
  return {
    crema: Boolean(options.crema),
    lvChordia: Boolean(options.lvChordia),
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
  } else {
    args.push("--no-crema");
  }
  if (validated.beatThis) {
    args.push("--beat-this");
  } else {
    args.push("--no-beat-this");
  }
  if (validated.lvChordia) {
    args.push("--lv-chordia");
  } else {
    args.push("--no-lv-chordia");
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
  if (validated.lvChordia) {
    args.push("--extra", "lv-chordia");
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
