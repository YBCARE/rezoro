'use strict';
/*
 * One-time (idempotent) seed of the ~117 built-in celebrities that used to
 * live only as hardcoded HTML/JS in index.html and fans.html. Importing
 * them as real rows makes them fully admin-manageable — edit, hide,
 * delete, or replace their photo — the same as any celebrity added
 * through the admin panel.
 *
 * Safe to run on every startup: it only INSERTS celebrities whose name
 * isn't already present (case-insensitive) and never touches or
 * overwrites an existing row, so admin edits are never reverted.
 */

const BUILT_IN_CELEBRITIES = [
  { name: 'Leonardo DiCaprio', tier: 'gold', knownFor: 'Film · Drama', wiki: 'Leonardo_DiCaprio' },
  { name: 'Zendaya', tier: 'gold', knownFor: 'Film · Fashion', wiki: 'Zendaya' },
  { name: 'Tom Cruise', tier: 'gold', knownFor: 'Film · Action', wiki: 'Tom_Cruise' },
  { name: 'Dwayne Johnson', tier: 'gold', knownFor: 'Film · Action', wiki: 'Dwayne_Johnson' },
  { name: 'Scarlett Johansson', tier: 'gold', knownFor: 'Film · Action', wiki: 'Scarlett_Johansson' },
  { name: 'Robert Downey Jr', tier: 'gold', knownFor: 'Film · Marvel', wiki: 'Robert_Downey_Jr.' },
  { name: 'Brad Pitt', tier: 'gold', knownFor: 'Film · Drama', wiki: 'Brad_Pitt' },
  { name: 'Will Smith', tier: 'gold', knownFor: 'Film · Comedy', wiki: 'Will_Smith' },
  { name: 'Denzel Washington', tier: 'gold', knownFor: 'Film · Drama', wiki: 'Denzel_Washington' },
  { name: 'Morgan Freeman', tier: 'gold', knownFor: 'Film · Drama', wiki: 'Morgan_Freeman' },
  { name: 'Angelina Jolie', tier: 'gold', knownFor: 'Film · Drama', wiki: 'Angelina_Jolie' },
  { name: 'Matt Damon', tier: 'gold', knownFor: 'Film · Drama', wiki: 'Matt_Damon' },
  { name: 'Keanu Reeves', tier: 'gold', knownFor: 'Film · Action', wiki: 'Keanu_Reeves' },
  { name: 'Benedict Cumberbatch', tier: 'gold', knownFor: 'Film · Drama', wiki: 'Benedict_Cumberbatch' },
  { name: 'Julia Roberts', tier: 'gold', knownFor: 'Film · Drama', wiki: 'Julia_Roberts' },
  { name: 'Bradley Cooper', tier: 'gold', knownFor: 'Film · Drama', wiki: 'Bradley_Cooper' },
  { name: 'Liam Neeson', tier: 'gold', knownFor: 'Film · Action', wiki: 'Liam_Neeson' },
  { name: 'Ian McKellen', tier: 'gold', knownFor: 'Film · Fantasy', wiki: 'Ian_McKellen' },
  { name: 'Hugh Jackman', tier: 'gold', knownFor: 'Film · Action', wiki: 'Hugh_Jackman' },
  { name: 'Harrison Ford', tier: 'gold', knownFor: 'Film · Action', wiki: 'Harrison_Ford' },
  { name: 'Clint Eastwood', tier: 'gold', knownFor: 'Film · Western', wiki: 'Clint_Eastwood' },
  { name: 'Samuel L. Jackson', tier: 'gold', knownFor: 'Film · Action', wiki: 'Samuel_L._Jackson' },
  { name: 'Ryan Gosling', tier: 'gold', knownFor: 'Film · Drama', wiki: 'Ryan_Gosling' },
  { name: 'Gal Gadot', tier: 'gold', knownFor: 'Film · Action', wiki: 'Gal_Gadot' },
  { name: 'Paul McCartney', tier: 'gold', knownFor: 'Music · Rock', wiki: 'Paul_McCartney' },
  { name: 'Bad Bunny', tier: 'gold', knownFor: 'Music · Reggaeton', wiki: 'Bad_Bunny' },
  { name: 'Johnny Depp', tier: 'silver', knownFor: 'Film · Drama', wiki: 'Johnny_Depp' },
  { name: 'Jason Momoa', tier: 'silver', knownFor: 'Film · Action', wiki: 'Jason_Momoa' },
  { name: 'Ryan Reynolds', tier: 'silver', knownFor: 'Film · Comedy', wiki: 'Ryan_Reynolds' },
  { name: 'Chris Hemsworth', tier: 'silver', knownFor: 'Film · Action', wiki: 'Chris_Hemsworth' },
  { name: 'Margot Robbie', tier: 'silver', knownFor: 'Film · Drama', wiki: 'Margot_Robbie' },
  { name: 'Chris Evans', tier: 'silver', knownFor: 'Film · Action', wiki: 'Chris_Evans_(actor)' },
  { name: 'Henry Cavill', tier: 'silver', knownFor: 'Film · Action', wiki: 'Henry_Cavill' },
  { name: 'Charlize Theron', tier: 'silver', knownFor: 'Film · Action', wiki: 'Charlize_Theron' },
  { name: 'Kevin Costner', tier: 'silver', knownFor: 'Film · Drama', wiki: 'Kevin_Costner' },
  { name: 'Can Yaman', tier: 'silver', knownFor: 'TV · Drama', wiki: 'Can_Yaman' },
  { name: 'Robert Pattinson', tier: 'silver', knownFor: 'Film · Drama', wiki: 'Robert_Pattinson' },
  { name: 'Colin Farrell', tier: 'silver', knownFor: 'Film · Drama', wiki: 'Colin_Farrell' },
  { name: 'Charlie Hunnam', tier: 'silver', knownFor: 'Film · Action', wiki: 'Charlie_Hunnam' },
  { name: 'Brendan Fraser', tier: 'silver', knownFor: 'Film · Drama', wiki: 'Brendan_Fraser' },
  { name: 'Sam Heughan', tier: 'silver', knownFor: 'TV · Drama', wiki: 'Sam_Heughan' },
  { name: 'Kenny Chesney', tier: 'silver', knownFor: 'Music · Country', wiki: 'Kenny_Chesney' },
  { name: 'George Strait', tier: 'silver', knownFor: 'Music · Country', wiki: 'George_Strait' },
  { name: 'Jim Parsons', tier: 'silver', knownFor: 'TV · Comedy', wiki: 'Jim_Parsons' },
  { name: 'Travis Fimmel', tier: 'silver', knownFor: 'TV · Drama', wiki: 'Travis_Fimmel' },
  { name: 'Mark Harmon', tier: 'silver', knownFor: 'TV · Drama', wiki: 'Mark_Harmon' },
  { name: 'Michael Sheen', tier: 'silver', knownFor: 'Film · Drama', wiki: 'Michael_Sheen' },
  { name: 'David Tennant', tier: 'silver', knownFor: 'TV · Drama', wiki: 'David_Tennant' },
  { name: 'James McAvoy', tier: 'silver', knownFor: 'Film · Drama', wiki: 'James_McAvoy' },
  { name: 'Simon Baker', tier: 'silver', knownFor: 'TV · Drama', wiki: 'Simon_Baker' },
  { name: 'Gustaf Skarsgård', tier: 'silver', knownFor: 'TV · Drama', wiki: 'Gustaf_Skarsgård' },
  { name: 'Piers Morgan', tier: 'silver', knownFor: 'TV · News', wiki: 'Piers_Morgan' },
  { name: 'Jim Caviezel', tier: 'silver', knownFor: 'Film · Drama', wiki: 'Jim_Caviezel' },
  { name: 'Christopher Meloni', tier: 'silver', knownFor: 'TV · Drama', wiki: 'Christopher_Meloni' },
  { name: 'Tom Ellis', tier: 'silver', knownFor: 'TV · Drama', wiki: 'Tom_Ellis_(actor)' },
  { name: 'Aidan Turner', tier: 'silver', knownFor: 'TV · Drama', wiki: 'Aidan_Turner' },
  { name: 'Hyun Bin', tier: 'silver', knownFor: 'TV · K-Drama', wiki: 'Hyun_Bin' },
  { name: 'James Spader', tier: 'silver', knownFor: 'TV · Drama', wiki: 'James_Spader' },
  { name: 'Brad Paisley', tier: 'silver', knownFor: 'Music · Country', wiki: 'Brad_Paisley' },
  { name: 'Milo Ventimiglia', tier: 'silver', knownFor: 'TV · Drama', wiki: 'Milo_Ventimiglia' },
  { name: 'Nicolas Cage', tier: 'silver', knownFor: 'Film · Action', wiki: 'Nicolas_Cage' },
  { name: 'Gerard Butler', tier: 'silver', knownFor: 'Film · Action', wiki: 'Gerard_Butler' },
  { name: 'Michael Bolton', tier: 'silver', knownFor: 'Music · Pop', wiki: 'Michael_Bolton' },
  { name: 'Hugo Weaving', tier: 'silver', knownFor: 'Film · Drama', wiki: 'Hugo_Weaving' },
  { name: 'Taylor Kinney', tier: 'silver', knownFor: 'TV · Drama', wiki: 'Taylor_Kinney' },
  { name: 'Blake Shelton', tier: 'silver', knownFor: 'Music · Country', wiki: 'Blake_Shelton' },
  { name: 'Luke Bryan', tier: 'silver', knownFor: 'Music · Country', wiki: 'Luke_Bryan' },
  { name: 'Christopher Walken', tier: 'silver', knownFor: 'Film · Drama', wiki: 'Christopher_Walken' },
  { name: 'Alexander Skarsgård', tier: 'silver', knownFor: 'Film · Drama', wiki: 'Alexander_Skarsgård' },
  { name: 'Jeff Bridges', tier: 'silver', knownFor: 'Film · Drama', wiki: 'Jeff_Bridges' },
  { name: 'Jake Gyllenhaal', tier: 'silver', knownFor: 'Film · Drama', wiki: 'Jake_Gyllenhaal' },
  { name: 'Channing Tatum', tier: 'silver', knownFor: 'Film · Action', wiki: 'Channing_Tatum' },
  { name: 'Jason Statham', tier: 'silver', knownFor: 'Film · Action', wiki: 'Jason_Statham' },
  { name: 'Gary Oldman', tier: 'silver', knownFor: 'Film · Drama', wiki: 'Gary_Oldman' },
  { name: 'Eva Green', tier: 'silver', knownFor: 'Film · Drama', wiki: 'Eva_Green' },
  { name: 'Woody Harrelson', tier: 'silver', knownFor: 'Film · Drama', wiki: 'Woody_Harrelson' },
  { name: 'Matthew McConaughey', tier: 'silver', knownFor: 'Film · Drama', wiki: 'Matthew_McConaughey' },
  { name: 'Bob Odenkirk', tier: 'silver', knownFor: 'TV · Drama', wiki: 'Bob_Odenkirk' },
  { name: 'Terrence Howard', tier: 'silver', knownFor: 'TV · Drama', wiki: 'Terrence_Howard' },
  { name: 'Katheryn Winnick', tier: 'silver', knownFor: 'TV · Drama', wiki: 'Katheryn_Winnick' },
  { name: 'Sheryl Crow', tier: 'silver', knownFor: 'Music · Rock', wiki: 'Sheryl_Crow' },
  { name: 'Method Man', tier: 'silver', knownFor: 'Music · Hip-Hop', wiki: 'Method_Man' },
  { name: 'Manuel Garcia-Rulfo', tier: 'silver', knownFor: 'Film · Drama', wiki: 'Manuel_Garcia-Rulfo' },
  { name: 'Cillian Murphy', tier: 'bronze', knownFor: 'Film · Drama', wiki: 'Cillian_Murphy' },
  { name: 'Pedro Pascal', tier: 'bronze', knownFor: 'Film · Drama', wiki: 'Pedro_Pascal' },
  { name: 'Paul Mescal', tier: 'bronze', knownFor: 'Film · Drama', wiki: 'Paul_Mescal' },
  { name: 'Idris Elba', tier: 'bronze', knownFor: 'Film · Drama', wiki: 'Idris_Elba' },
  { name: 'Tom Hardy', tier: 'bronze', knownFor: 'Film · Action', wiki: 'Tom_Hardy' },
  { name: 'Michael B Jordan', tier: 'bronze', knownFor: 'Film · Drama', wiki: 'Michael_B._Jordan' },
  { name: 'Martin Short', tier: 'bronze', knownFor: 'Film · Comedy', wiki: 'Martin_Short' },
  { name: 'Chelsea Handler', tier: 'bronze', knownFor: 'TV · Comedy', wiki: 'Chelsea_Handler' },
  { name: 'Richie Sambora', tier: 'bronze', knownFor: 'Music · Rock', wiki: 'Richie_Sambora' },
  { name: 'Dylan McDermott', tier: 'bronze', knownFor: 'TV · Drama', wiki: 'Dylan_McDermott' },
  { name: 'Alex Scott', tier: 'bronze', knownFor: 'Sports · TV', wiki: 'Alex_Scott_(presenter)' },
  { name: 'Tyler Hynes', tier: 'bronze', knownFor: 'TV · Drama', wiki: 'Tyler_Hynes' },
  { name: 'Peter Gadiot', tier: 'bronze', knownFor: 'TV · Drama', wiki: 'Peter_Gadiot' },
  { name: 'Stjepan Hauser', tier: 'bronze', knownFor: 'Music · Classical', wiki: 'Stjepan_Hauser' },
  { name: 'Adeline Rudolph', tier: 'bronze', knownFor: 'TV · Drama', wiki: 'Adeline_Rudolph' },
  { name: 'Johannes Oerding', tier: 'bronze', knownFor: 'Music · Pop', wiki: 'Johannes_Oerding' },
  { name: 'Kaitlan Collins', tier: 'bronze', knownFor: 'TV · News', wiki: 'Kaitlan_Collins' },
  { name: 'Susanna Hoffs', tier: 'bronze', knownFor: 'Music · Rock', wiki: 'Susanna_Hoffs' },
  { name: 'Sveva Alviti', tier: 'bronze', knownFor: 'Film · Drama', wiki: 'Sveva_Alviti' },
  { name: 'Daren Kagasoff', tier: 'bronze', knownFor: 'TV · Drama', wiki: 'Daren_Kagasoff' },
  { name: 'Matthew Gray Gubler', tier: 'bronze', knownFor: 'TV · Drama', wiki: 'Matthew_Gray_Gubler' },
  { name: 'Trai Byers', tier: 'bronze', knownFor: 'TV · Drama', wiki: 'Trai_Byers' },
  { name: 'Ryan Phillippe', tier: 'bronze', knownFor: 'Film · Drama', wiki: 'Ryan_Phillippe' },
  { name: 'Megan Boone', tier: 'bronze', knownFor: 'TV · Drama', wiki: 'Megan_Boone' },
  { name: 'Michele Morrone', tier: 'bronze', knownFor: 'Film · Drama', wiki: 'Michele_Morrone' },
  { name: 'Joseph Sikora', tier: 'bronze', knownFor: 'TV · Drama', wiki: 'Joseph_Sikora' },
  { name: 'David Boreanaz', tier: 'bronze', knownFor: 'TV · Drama', wiki: 'David_Boreanaz' },
  { name: 'Tom Payne', tier: 'bronze', knownFor: 'TV · Drama', wiki: 'Tom_Payne_(actor)' },
  { name: 'Philip Winchester', tier: 'bronze', knownFor: 'TV · Drama', wiki: 'Philip_Winchester' },
  { name: 'Sullivan Stapleton', tier: 'bronze', knownFor: 'Film · Action', wiki: 'Sullivan_Stapleton' },
  { name: 'Paul Anderson', tier: 'bronze', knownFor: 'TV · Drama', wiki: 'Paul_Anderson_(actor)' },
  { name: 'Stanley Weber', tier: 'bronze', knownFor: 'Film · Drama', wiki: 'Stanley_Weber' },
  { name: 'Martin Henderson', tier: 'bronze', knownFor: 'TV · Drama', wiki: 'Martin_Henderson_(actor)' },
  { name: 'Ryan Eggold', tier: 'bronze', knownFor: 'TV · Drama', wiki: 'Ryan_Eggold' },
];

async function seedBuiltInCelebrities(store) {
  const existing = await store.celebrities.all();
  const existingNames = new Set(existing.map(c => c.name.trim().toLowerCase()));

  let added = 0;
  for (const c of BUILT_IN_CELEBRITIES) {
    if (existingNames.has(c.name.trim().toLowerCase())) continue;
    await store.celebrities.create({
      name: c.name, tier: c.tier, knownFor: c.knownFor, wiki: c.wiki,
      trailerUrl: '', visible: true, photo: null,
    });
    added++;
  }
  if (added > 0) {
    console.log(`[seed] Added ${added} built-in celebrities (${existing.length + added} total).`);
  }
}

module.exports = { seedBuiltInCelebrities, BUILT_IN_CELEBRITIES };
