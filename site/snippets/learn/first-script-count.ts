// Lesson 2, challenge: how many logs do you have now?
import { run, Trees, Items } from 'melvor-script';

run(async (m) => {
  await m.skills.woodcutting.cut(Trees.Normal, { count: 10 });
  m.log(`I have ${m.bank.count(Items.Normal_Logs)} normal logs.`);
});
