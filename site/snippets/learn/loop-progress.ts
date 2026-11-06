// Lesson 3, challenge: report progress every 10 chops. `chops % 10` is the remainder
// after dividing by 10, so it's 0 on chop 10, 20, 30...
import { run, Trees, Items } from 'melvor-script';

run(async (m) => {
  let chops = 0;
  while (m.bank.count(Items.Normal_Logs) < 100) {
    await m.skills.woodcutting.cut(Trees.Normal);
    chops++;
    if (chops % 10 === 0) m.log(`${chops} chops so far`);
  }
});
