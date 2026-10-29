// Sääntöpohjainen vastaus mockeille (T-79-G): <avain>.json datahakemistossa = [{ sisaltaa?, koodi?, stdout?, stdoutBase64?, stderr? }].
// Ensimmäinen sääntö, jonka `sisaltaa` esiintyy argv:n välilyönnillä yhdistetyssä tekstissä (puuttuva = kaikki), vastaa;
// ei sääntöä tai ei tiedostoa → vastaa(avain, oletus) eli <avain>.txt/.stderr/.koodi kuten T-63-G:n mockit. Ei tuo mitään scopes/-polusta.
import { lueData, onData, vastaa } from './mock-lib.mjs';

export function vastaaSaannoilla(avain, argv, oletus = {}) {
  if (onData(avain, 'json')) {
    const s = JSON.parse(lueData(avain, 'json')).find((x) => x.sisaltaa === undefined || argv.join(' ').includes(x.sisaltaa));
    if (s) {
      process.stdout.write(s.stdoutBase64 !== undefined ? Buffer.from(s.stdoutBase64, 'base64') : (s.stdout ?? ''));
      process.stderr.write(s.stderr ?? '');
      return s.koodi ?? 0;
    }
  }
  return vastaa(avain, oletus);
}
