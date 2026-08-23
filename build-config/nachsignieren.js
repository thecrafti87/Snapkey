'use strict';

/* =================================================================
   Signiert das gebaute Buendel ad-hoc, wenn kein echtes Zertifikat da ist.

   Ohne das bleibt Electrons eigene Signatur stehen - die passt aber
   nicht mehr zum veraenderten Buendel, und codesign meldet dann
   "code has no resources but signature indicates they must be present".
   Die App laeuft trotzdem, aber sie traegt eine widerspruechliche
   Signatur und meldet sich als "Electron" statt als SNAPKEY.

   Eine ad-hoc-Signatur macht sie nicht vertrauenswuerdig - dafuer
   braucht es Apples Kennung. Sie macht sie nur in sich stimmig, und das
   kostet nichts.

   Liegt ein echtes Zertifikat vor, tut dieser Haken nichts: dann hat
   electron-builder schon ordentlich signiert.
   ================================================================= */

const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function nachsignieren(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  let echt = '';
  try {
    echt = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  } catch { /* kein Schluesselbund erreichbar - dann eben ad-hoc */ }

  if (echt.includes('Developer ID Application')) {
    console.log('  • echtes Zertifikat vorhanden - nicht nachsigniert');
    return;
  }

  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'ignore' });
    console.log('  • ad-hoc nachsigniert (kein Zertifikat vorhanden)');
  } catch (err) {
    // Kein Grund, den Bau abzubrechen - die App laeuft auch so.
    console.log(`  • ad-hoc-Signieren nicht geglueckt: ${err.message}`);
  }
};
