// First contact: read state, write to the in-game panel.
//   bun examples/hello.ts      (or open this file and press F5)
import { run } from 'melvor-script';

run(async (m) => {
  const s = m.state;
  m.log(`Hello from VS Code, ${s.meta.characterName}!`);
  m.log(
    `Woodcutting ${m.skills.woodcutting.level} · ${m.gp.toLocaleString()} GP · bank ${m.bank.usedSlots}/${m.bank.maxSlots}`,
  );
  m.log(
    `Script Mode is ${m.scriptMode ? 'ON: nothing happens unless a script says so' : 'off: the game also idles normally'}`,
  );

  const top = Object.values(s.skills)
    .sort((a, b) => b.xp - a.xp)
    .slice(0, 3)
    .map((sk) => `${sk.name} ${sk.level}`);
  m.log(`Top skills: ${top.join(', ')}`);
});
