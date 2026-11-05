/**
 * `melvor init`: set up a project that installed melvor-script from GitHub
 * (`bun add github:c3d-gg/melvor-script#vX.Y.Z`) so it's ready to write scripts in.
 * Only creates files that don't exist yet; it never overwrites.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const REPO = 'https://github.com/c3d-gg/melvor-script';

const TSCONFIG = `{
  // Scripts run on Bun, which runs TypeScript directly; this is only for type checking in VS Code.
  "compilerOptions": {
    "target": "ESNext",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "lib": ["ESNext"],
    "types": ["bun"],
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["scripts/**/*.ts"]
}
`;

const LAUNCH = `{
  "version": "0.2.0",
  "configurations": [
    {
      // F5 runs (and debugs) the open script. Needs the Bun extension (oven.bun-vscode).
      "name": "Run script (current file)",
      "type": "bun",
      "request": "launch",
      "program": "\${file}",
      "cwd": "\${workspaceFolder}"
    }
  ]
}
`;

const EXTENSIONS = `{
  "recommendations": ["oven.bun-vscode"]
}
`;

interface Pkg {
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function init(target: string, packageRoot: string): void {
  const version = readJson<Pkg>(join(packageRoot, 'package.json'))?.version ?? 'X.Y.Z';
  const hello = readFileSync(join(packageRoot, 'examples', 'hello.ts'), 'utf8').replace(
    'bun examples/hello.ts',
    'bun scripts/hello.ts',
  );
  const files: [string, string][] = [
    ['scripts/hello.ts', hello],
    ['tsconfig.json', TSCONFIG],
    ['.vscode/launch.json', LAUNCH],
    ['.vscode/extensions.json', EXTENSIONS],
  ];
  for (const [rel, content] of files) {
    const file = join(target, rel);
    if (existsSync(file)) {
      console.log(`  kept     ${rel} (already exists)`);
      continue;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    console.log(`  created  ${rel}`);
  }

  const pkg = readJson<Pkg>(join(target, 'package.json'));
  const warnings: string[] = [];
  if (!pkg) warnings.push('No package.json here. Run `bun init -y` first, then `bun add github:c3d-gg/melvor-script`.');
  else {
    if (!pkg.dependencies?.['melvor-script'] && !pkg.devDependencies?.['melvor-script'])
      warnings.push(`melvor-script isn't a dependency yet: bun add github:c3d-gg/melvor-script#v${version}`);
    if (!pkg.devDependencies?.['@types/bun'] && !pkg.dependencies?.['@types/bun'])
      warnings.push('For types in VS Code: bun add -d @types/bun');
  }
  const tsconfig = readFileSync(join(target, 'tsconfig.json'), 'utf8');
  if (!/"allowImportingTsExtensions"\s*:\s*true/.test(tsconfig))
    warnings.push(
      'Your tsconfig.json needs "allowImportingTsExtensions": true (melvor-script ships TypeScript source).',
    );
  for (const w of warnings) console.log(`\n  ! ${w}`);

  console.log(`
Next:
  1. Install the mod in Melvor Idle (Steam): Mod Manager → Browse → search "Melvor Script" →
     Subscribe, then restart the game (or https://mod.io/g/melvoridle/m/melvor-script).
  2. Load a character, or create one in Scripted Mode.
  3. bun scripts/hello.ts   (or open it in VS Code and press F5)

Examples: ${REPO}/tree/main/examples`);
}
