# TASK: T-50 ajo 2 — liite-testin (f) epävakaus kahden solmun työnnössä

Koordinaattori 19.10.2026 (yövalvojan tarkistus, VALVOJA 4.1): puhtaassa worktreessa 2/3 ajoa punaisia — `tests/liite.rs:342` `f_kaksi_solmua_tyonto_ja_vertaisvika` saa 503 odotetun 200:n sijaan (A:n liitteen työntö B:lle); ainoa vihreä ajo kesti 64 s.

## Task
Selvitä juurisyy ja korjaa. Ehdokkaat: B:n valmius ennen työntöä (`odota_valmiiksi` tarkistaa vain terveyden, ei esim. avainta/reittiä), portin varaus (18797/18798 muiden ajojen kanssa), `liite.rs`:n oma rusqlite-yhteys ja lukitus (SQLITE_BUSY vastaanottajalla → PUT epäonnistuu → 503), reqwest-asiakkaan aikaraja tai yhteyden uudelleenkäyttö, vertaisosoitteen muoto. Aikarajan pidentäminen ei kelpaa ainoaksi korjaukseksi.

## Files
may: scopes2/ydin/src/liite.rs, scopes2/ydin/src/varasto.rs (vain jos juurisyy on yhteys/lukitus ja korjaus on Varaston API liitteet-taululle), scopes2/ydin/tests/liite.rs, scopes2/ydin/gate.sh (vain tapausrivi T-50)
must not: scopes/**, muut scopes2/ydin/src/*.rs, Cargo.toml, scopes2/{shared,web,adapteri}/**, tuotannon 8797 ja target/release, .git

## Do
1. Toista vika puhtaassa worktreessa: `git worktree add /tmp/claude-1000/-home-user-palvelin/db7cb8ad-54b3-403b-895c-bb2f718cf0ea/scratchpad/wt-t50 HEAD` (oma CARGO_TARGET_DIR worktreen sisällä), aja `cargo test --test liite -- --test-threads=1 --nocapture` toistuvasti ja kerää 503:n syy (lisää tarvittaessa väliaikainen eprintln vastaanottajan/työntäjän virheestä; poista ennen lopputilaa tai jätä hyödyllinen lokirivi ilman salaisuuksia).
2. Korjaa juurisyy päätyöpuussa (may-polut). Jos testi itse oli kilpaileva (valmius, portit), korjaa testi; jos tuotekoodi, korjaa se ja lisää regressiotesti.
3. Hyväksyntä: puhtaassa worktreessa (päivitä korjauksella) `cargo test --test liite` 10/10 peräkkäistä ajoa vihreinä, kesto per ajo kirjattuna; sitten päätyöpuussa `cargo test --test silta` (T-23) ja `cargo test --test kaksi_solmua -- --test-threads=1` (T-22), fmt --check ja clippy -D warnings.
4. Poista worktree lopuksi (`git worktree remove`; tarkista ensin, ettei siinä ole tallentamattomia muutoksia).

## Rajat
Yksi käännös kerrallaan `flock /tmp/scopes2-cargo.lock`, `free -m` available > 1500 ennen jokaista; ei `--release` oletuskohteeseen; ei 8797:ää; tapa kaikki käynnistämäsi testiprosessit. Ei committia.

## Report (kuusi riviä)
Status / Changed / Gates (10 ajon kestot) / Tokens / Notes (juurisyy todisteineen) / Blocked

## Budget: 150 k tokenia, 60 min
