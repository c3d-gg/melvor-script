// Keeps every allotment busy: harvest what's grown, compost and replant the empty plots, wait.
// Runs until you stop it or the seeds run out. Farming calls cost no cooldown, so this can
// run alongside another script that's doing actions.
//
// In the Scripted gamemode crops grow in their normal time ÷ your Farming speed setting.
import { run, Crops, FarmingCategories, Items, MelvorError } from 'melvor-script';

const CROP = Crops.Potatoes;

run(async (m) => {
  const farming = m.skills.farming;
  for (;;) {
    const h = await farming.harvestAll();
    if (h.harvested.length || h.died.length) m.log(`harvested ${h.harvested.length}, ${h.died.length} died`, h.items);

    for (const plot of await farming.plots(FarmingCategories.Allotment)) {
      if (plot.status === 'empty' && !plot.compost && m.bank.has(Items.Compost))
        await farming.compost(plot.id, Items.Compost);
    }
    try {
      const { planted } = await farming.plantAll(CROP);
      if (planted.length) m.log(`planted ${planted.length} plots`);
    } catch (e) {
      if (e instanceof MelvorError && e.code === 'MISSING_ITEMS') return m.warn('out of seeds');
      throw e;
    }

    const ready = await farming.whenGrown();
    m.log(`${ready.length} plot(s) ready`);
  }
});
