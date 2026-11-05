// Runs the demo commands and stores their real output for render_gif.py.
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const shown = [
  'nm-manager init --store ~/.nm-store',
  'nm-manager scan ~/projects',
  'nm-manager apply ~/projects --yes',
  'nm-manager status',
];

const steps = shown.map((command) => {
  console.log(`$ ${command}`);
  const output = execSync(`${command} 2>&1`, { encoding: 'utf8', shell: '/bin/bash' });
  console.log(output);
  return { command, output };
});
writeFileSync(process.argv[2], JSON.stringify(steps, null, 2));
