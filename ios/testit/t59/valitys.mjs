// T-59: TCP-välitys 127.0.0.1:<kuuntelu> → 127.0.0.1:<kohde>. "Tunneli suljettuna" = tämä prosessi pysäytetty.
// Käyttö: node valitys.mjs <kuuntelu> <kohde>   (SIGTERM sulkee kuuntelijan ja kaikki yhteydet)
import net from 'node:net';

const [kuuntelu, kohde] = process.argv.slice(2).map(Number);
if (!kuuntelu || !kohde) { console.error('käyttö: valitys.mjs <kuuntelu> <kohde>'); process.exit(2); }
const yhteydet = new Set();
const palvelin = net.createServer((asiakas) => {
  const ylos = net.connect(kohde, '127.0.0.1');
  for (const s of [asiakas, ylos]) { yhteydet.add(s); s.on('close', () => { yhteydet.delete(s); }); s.on('error', () => { asiakas.destroy(); ylos.destroy(); }); }
  asiakas.pipe(ylos); ylos.pipe(asiakas);
});
palvelin.listen(kuuntelu, '127.0.0.1', () => console.log(`VALITYS: ${kuuntelu} → ${kohde}`));
const sulje = () => { palvelin.close(); for (const s of yhteydet) s.destroy(); process.exit(0); };
process.on('SIGTERM', sulje); process.on('SIGINT', sulje);
