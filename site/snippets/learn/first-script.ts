// Lesson 2: your first script. Chops ten trees, then says what level you are.
import { run, Trees } from 'melvor-script';

run(async (m) => {
  m.log('Off to chop some trees!');
  await m.skills.woodcutting.cut(Trees.Normal, { count: 10 });
  m.log(`Done! Woodcutting is level ${m.skills.woodcutting.level}.`);
});
