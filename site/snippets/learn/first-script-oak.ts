// Lesson 2, challenge: oak trees. Below Woodcutting level 10 the game refuses, and the
// script stops with an error that says why ("Oak Tree requires Woodcutting level 10").
import { run, Trees } from 'melvor-script';

run(async (m) => {
  await m.skills.woodcutting.cut(Trees.Oak, { count: 10 });
  m.log(`Done! Woodcutting is level ${m.skills.woodcutting.level}.`);
});
