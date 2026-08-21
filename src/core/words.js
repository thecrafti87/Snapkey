'use strict';

const crypto = require('crypto');

/**
 * Wortschatz fuer gewuerfelte Dauercodes. Bewusst kurze, gut vorlesbare
 * Hauptwoerter ohne Umlaute und Sonderzeichen, damit der Code sich ueber
 * jeden Kanal weitergeben laesst.
 */
const WORDS = [...new Set([
  'anker', 'apfel', 'april', 'arbeit', 'atlas', 'auge', 'bach', 'baum',
  'becher', 'berg', 'beruf', 'besen', 'biene', 'bild', 'birke', 'blatt',
  'blei', 'blume', 'boden', 'bogen', 'bohne', 'boot', 'brief', 'brot',
  'bruecke', 'buch', 'burg', 'dach', 'damm', 'daten', 'decke', 'degen',
  'delfin', 'diele', 'distel', 'dose', 'drache', 'draht', 'druck', 'duft',
  'duene', 'eiche', 'eimer', 'elch', 'engel', 'ente', 'erbse', 'erde',
  'esel', 'essig', 'eule', 'fahne', 'faden', 'falke', 'farbe', 'fass',
  'feder', 'feld', 'fels', 'fenster', 'ferse', 'feuer', 'film', 'finger',
  'fisch', 'flagge', 'flasche', 'floss', 'fluss', 'forst', 'frosch',
  'fuchs', 'funke', 'gabel', 'gans', 'garten', 'gasse', 'geige', 'geist',
  'gerste', 'gipfel', 'glas', 'glocke', 'gold', 'granit', 'gras', 'griff',
  'grotte', 'gurke', 'hafen', 'hafer', 'hahn', 'hamster', 'hand', 'hang',
  'harfe', 'hase', 'haus', 'hecke', 'heft', 'helm', 'herbst', 'herd',
  'hirsch', 'hobel', 'hoehle', 'holz', 'honig', 'horn', 'hose', 'hufe',
  'huegel', 'huhn', 'hund', 'igel', 'insel', 'jacke', 'jagd', 'kabel',
  'kaefer', 'kahn', 'kamel', 'kamm', 'kanne', 'kanu', 'karte', 'kaese',
  'kasten', 'katze', 'kelch', 'kerze', 'kette', 'kiefer', 'kiel', 'kies',
  'kiste', 'klee', 'klinge', 'knopf', 'koffer', 'kohle', 'komet', 'korb',
  'korn', 'kran', 'kranich', 'kraut', 'kreide', 'kreis', 'krug', 'kruste',
  'kueche', 'kugel', 'kupfer', 'lampe', 'land', 'laterne', 'laub', 'leder',
  'lehm', 'leine', 'lerche', 'licht', 'linde', 'lippe', 'luchs', 'luft',
  'lupe', 'magnet', 'mais', 'mandel', 'mantel', 'markt', 'marmor', 'mast',
  'mauer', 'maus', 'meer', 'messer', 'metall', 'minze', 'mond', 'moor',
  'moos', 'motor', 'muehle', 'muschel', 'nadel', 'nagel', 'narbe', 'nase',
  'nebel', 'nelke', 'nest', 'netz', 'niete', 'norden', 'nudel', 'nuss',
  'oase', 'obst', 'ofen', 'olive', 'orgel', 'otter', 'palme', 'panzer',
  'papier', 'park', 'pfad', 'pfeil', 'pferd', 'pflaume', 'pilz', 'pinsel',
  'planet', 'platte', 'pult', 'quark', 'quelle', 'rabe', 'rahmen',
  'rakete', 'rand', 'rasen', 'raupe', 'regal', 'regen', 'reifen', 'reis',
  'riegel', 'riff', 'rind', 'ring', 'rinne', 'rippe', 'rock', 'rohr',
  'rolle', 'rose', 'rost', 'ruder', 'sack', 'saft', 'salbei', 'salz',
  'samt', 'sand', 'saum', 'schacht', 'schale', 'schaf', 'schaum',
  'scheibe', 'schere', 'schiff', 'schild', 'schloss', 'schnee', 'schuh',
  'schwan', 'segel', 'seil', 'senf', 'sessel', 'silber', 'sirup', 'socke',
  'sonne', 'spaten', 'specht', 'spiegel', 'spinne', 'sporn', 'spule',
  'stadt', 'stahl', 'stein', 'stern', 'stiel', 'stock', 'stroh', 'strom',
  'stufe', 'stuhl', 'sturm', 'tafel', 'tanne', 'tasche', 'tasse', 'taube',
  'teich', 'teller', 'tiger', 'tinte', 'tisch', 'topf', 'traube', 'treppe',
  'trichter', 'trommel', 'truhe', 'tuch', 'tulpe', 'turm', 'ufer', 'uhr',
  'ulme', 'vase', 'veilchen', 'vogel', 'vulkan', 'waage', 'wabe', 'wagen',
  'wald', 'wange', 'wanne', 'wappen', 'ware', 'wasser', 'weber', 'weide',
  'welle', 'werft', 'weste', 'wiege', 'wiese', 'wind', 'winkel', 'wolke',
  'wolle', 'wurzel', 'zahn', 'zange', 'zaun', 'zebra', 'zeder', 'zelt',
  'ziegel', 'zinn', 'zirkel', 'zitrone', 'zopf', 'zucker', 'zweig', 'zwerg'
])];

const LENGTH = 6;

/** Wuerfelt eine Wortgruppe aus kryptografisch sicherem Zufall. */
function makeCode(count = LENGTH) {
  const picked = [];
  for (let i = 0; i < count; i++) picked.push(WORDS[crypto.randomInt(WORDS.length)]);
  return picked.join('-');
}

/** Naeherungswert, wie schwer der Code zu erraten ist. */
function strengthBits(count = LENGTH) {
  return Math.round(count * Math.log2(WORDS.length));
}

module.exports = { WORDS, LENGTH, makeCode, strengthBits };
