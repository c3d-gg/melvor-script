// Handling a refused call, for the concepts page.
import { run, Trees, MelvorError } from 'melvor-script';

run(async (m) => {
  // #region errors
  try {
    await m.skills.woodcutting.cut(Trees.Yew, { count: 10 });
  } catch (e) {
    if (!(e instanceof MelvorError)) throw e; // a bug in the script: let it stop
    if (e.code === 'LOCKED')
      m.warn(`Not yet: ${e.message}`); // "Yew Tree requires Woodcutting level 60"
    else if (e.code === 'MISSING_ITEMS') m.warn(`Short of something: ${e.message}`);
    else throw e;
  }
  // #endregion
});
