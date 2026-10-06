/**
 * Subtitle bytes in every legacy encoding the detector knows, produced by
 * iconv-lite once and kept as hex so the suite needs no encoder of its own.
 * Test data only: the server build leaves *.fixtures.ts out.
 */

export const FIXTURES: Record<string, { encoding: string; text: string; hex: string }> = {
  server_windows1252: {
    encoding: "windows-1252",
    text: "1\n00:00:01,000 --> 00:00:04,000\nVoilà, déjà vu — naïve garçon café résumé\nUne journée à Montréal, très élégante époque\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30342c3030300a566f696ce02c2064e96ae02076752097206e61ef766520676172e76f6e20636166e92072e973756de90a556e65206a6f75726ee96520e0204d6f6e7472e9616c2c207472e87320e96ce967616e746520e9706f7175650a",
  },
  server_gbk: {
    encoding: "gbk",
    text: "1\n00:00:01,000 --> 00:00:04,000\n你好世界，这是一个测试字幕文件\n我们正在翻译中文字幕的内容\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30342c3030300ac4e3bac3cac0bde7a3acd5e2cac7d2bbb8f6b2e2cad4d7d6c4bbcec4bcfe0aced2c3c7d5fdd4dab7add2ebd6d0cec4d7d6c4bbb5c4c4dac8dd0a",
  },
  client_big5: {
    encoding: "big5",
    text: "1\n00:00:01,000 --> 00:00:02,000\n中文字幕測試，這是一個繁體中文的檔案\n我們正在翻譯字幕的內容\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300aa4a4a4e5a672b9f5b4fab8d5a141b36fac4fa440add3c163c5e9a4a4a4e5aabac0c9aed70aa7daadcca5bfa662c2bdc4b6a672b9f5aabaa4baae650a",
  },
  client_sjis: {
    encoding: "shift_jis",
    text: "1\n00:00:01,000 --> 00:00:02,000\nこんにちは、これは日本語の字幕ファイルです\n字幕の内容を翻訳しています\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300a82b182f182c982bf82cd814182b182ea82cd93fa967b8cea82cc8e9a968b837483408343838b82c582b70a8e9a968b82cc93e0976582f0967c96f382b582c482a282dc82b70a",
  },
  client_gbk: {
    encoding: "gbk",
    text: "1\n00:00:01,000 --> 00:00:02,000\n你好世界，这是一个测试字幕文件\n我们正在翻译中文字幕的内容\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300ac4e3bac3cac0bde7a3acd5e2cac7d2bbb8f6b2e2cad4d7d6c4bbcec4bcfe0aced2c3c7d5fdd4dab7add2ebd6d0cec4d7d6c4bbb5c4c4dac8dd0a",
  },
  client_windows1252: {
    encoding: "windows-1252",
    text: "1\n00:00:01,000 --> 00:00:02,000\nVoilà, déjà vu — naïve garçon café résumé\nUne journée à Montréal, très élégante époque\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300a566f696ce02c2064e96ae02076752097206e61ef766520676172e76f6e20636166e92072e973756de90a556e65206a6f75726ee96520e0204d6f6e7472e9616c2c207472e87320e96ce967616e746520e9706f7175650a",
  },
  client_emdash: {
    encoding: "windows-1252",
    text: "1\n00:00:01,000 --> 00:00:02,000\nVoilà — café\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300a566f696ce0209720636166e90a",
  },
  euckr: {
    encoding: "euc-kr",
    text: "1\n00:00:01,000 --> 00:00:02,000\n안녕하세요, 이것은 한국어 자막 파일입니다\n자막 내용을 번역하고 있습니다\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300abec8b3e7c7cfbcbcbfe42c20c0ccb0cdc0ba20c7d1b1b9beee20c0dab8b720c6c4c0cfc0d4b4cfb4d90ac0dab8b720b3bbbfebc0bb20b9f8bfaac7cfb0ed20c0d6bdc0b4cfb4d90a",
  },
  cp1251: {
    encoding: "windows-1251",
    text: "1\n00:00:01,000 --> 00:00:02,000\nПривет, это тестовый файл субтитров\nМы переводим содержимое субтитров\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300acff0e8e2e5f22c20fdf2ee20f2e5f1f2eee2fbe920f4e0e9eb20f1f3e1f2e8f2f0eee20accfb20efe5f0e5e2eee4e8ec20f1eee4e5f0e6e8eceee520f1f3e1f2e8f2f0eee20a",
  },
  koi8r: {
    encoding: "koi8-r",
    text: "1\n00:00:01,000 --> 00:00:02,000\nПривет, это тестовый файл субтитров\nМы переводим содержимое субтитров\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300af0d2c9d7c5d42c20dcd4cf20d4c5d3d4cfd7d9ca20c6c1cacc20d3d5c2d4c9d4d2cfd70aedd920d0c5d2c5d7cfc4c9cd20d3cfc4c5d2d6c9cdcfc520d3d5c2d4c9d4d2cfd70a",
  },
  cp1250_pl: {
    encoding: "windows-1250",
    text: "1\n00:00:01,000 --> 00:00:02,000\nZażółć gęślą jaźń, to jest plik z napisami\nTłumaczymy treść napisów\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300a5a61bff3b3e62067ea9c6cb9206a619ff12c20746f206a65737420706c696b207a206e61706973616d690a54b3756d61637a796d79207472659ce6206e61706973f3770a",
  },
  cp1250_cs: {
    encoding: "windows-1250",
    text: "1\n00:00:01,000 --> 00:00:02,000\nPříliš žluťoučký kůň úpěl ďábelské ódy\nPřekládáme obsah titulků\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300a50f8ed6c699a209e6c759d6f75e86bfd206bf9f220fa70ec6c20efe162656c736be920f364790a50f8656b6ce164e16d65206f6273616820746974756c6bf90a",
  },
  cp1253: {
    encoding: "windows-1253",
    text: "1\n00:00:01,000 --> 00:00:02,000\nΓειά σου, αυτό είναι ένα αρχείο υποτίτλων\nΜεταφράζουμε τους υπότιτλους\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300ac3e5e9dc20f3eff52c20e1f5f4fc20e5dfede1e920ddede120e1f1f7e5dfef20f5f0eff4dff4ebf9ed0acce5f4e1f6f1dce6eff5ece520f4eff5f220f5f0fcf4e9f4ebeff5f20a",
  },
  cp1255: {
    encoding: "windows-1255",
    text: "1\n00:00:01,000 --> 00:00:02,000\nשלום, זהו קובץ כתוביות לבדיקה\nאנחנו מתרגמים את הכתוביות\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300af9ece5ed2c20e6e4e520f7e5e1f520ebfae5e1e9e5fa20ece1e3e9f7e40ae0f0e7f0e520eefaf8e2eee9ed20e0fa20e4ebfae5e1e9e5fa0a",
  },
  cp1256: {
    encoding: "windows-1256",
    text: "1\n00:00:01,000 --> 00:00:02,000\nمرحبا، هذا ملف ترجمة تجريبي\nنحن نترجم محتوى الترجمة\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300ae3d1cdc8c7a120e5d0c720e3e1dd20cad1cce3c920caccd1edc8ed0ae4cde420e4cad1cce320e3cdcae6ec20c7e1cad1cce3c90a",
  },
  cp874: {
    encoding: "windows-874",
    text: "1\n00:00:01,000 --> 00:00:02,000\nสวัสดี นี่คือไฟล์คำบรรยายทดสอบ\nเรากำลังแปลคำบรรยาย\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300acac7d1cab4d520b9d5e8a4d7cde4bfc5eca4d3bac3c3c2d2c2b7b4cacdba0ae0c3d2a1d3c5d1a7e1bbc5a4d3bac3c3c2d2c20a",
  },
  eucjp: {
    encoding: "euc-jp",
    text: "1\n00:00:01,000 --> 00:00:02,000\nこんにちは、これは日本語の字幕ファイルです\n字幕の内容を翻訳しています\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300aa4b3a4f3a4cba4c1a4cfa1a2a4b3a4eca4cfc6fccbdcb8eca4cebbfacbeba5d5a5a1a5a4a5eba4c7a4b90abbfacbeba4cec6e2cdc6a4f2cbddccf5a4b7a4c6a4a4a4dea4b90a",
  },
  cp1254_tr: {
    encoding: "windows-1254",
    text: "1\n00:00:01,000 --> 00:00:02,000\nMerhaba, bu bir altyazı dosyasıdır, şöyle güzel çalışıyor\nAltyazıları çeviriyoruz\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300a4d6572686162612c2062752062697220616c7479617afd20646f73796173fd64fd722c20fef6796c652067fc7a656c20e7616cfdfefd796f720a416c7479617afd6c6172fd20e76576697269796f72757a0a",
  },
  cp1252_de: {
    encoding: "windows-1252",
    text: "1\n00:00:01,000 --> 00:00:02,000\nSchöne Grüße aus München, die Straße ist überfüllt\nWir übersetzen die Untertitel\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300a536368f66e65204772fcdf6520617573204dfc6e6368656e2c206469652053747261df652069737420fc62657266fc6c6c740a57697220fc6265727365747a656e2064696520556e746572746974656c0a",
  },
  cp1252_es: {
    encoding: "windows-1252",
    text: "1\n00:00:01,000 --> 00:00:02,000\n¿Qué tal? El niño está en la montaña, ¡qué bien!\nEstamos traduciendo los subtítulos\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300abf5175e92074616c3f20456c206e69f16f20657374e120656e206c61206d6f6e7461f1612c20a17175e9206269656e210a457374616d6f732074726164756369656e646f206c6f732073756274ed74756c6f730a",
  },
  latin2_hu: {
    encoding: "iso-8859-2",
    text: "1\n00:00:01,000 --> 00:00:02,000\nÁrvíztűrő tükörfúrógép, ez egy feliratfájl\nFordítjuk a feliratokat\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300ac17276ed7a74fb72f52074fc6bf67266fa72f367e9702c20657a206567792066656c6972617466e16a6c0a466f7264ed746a756b20612066656c697261746f6b61740a",
  },
  utf16le_bom: {
    encoding: "utf-16le",
    text: "1\n00:00:01,000 --> 00:00:04,000\nCafé résumé naïve\n",
    hex: "fffe31000a00300030003a00300030003a00300031002c0030003000300020002d002d003e002000300030003a00300030003a00300034002c003000300030000a00430061006600e90020007200e900730075006d00e90020006e006100ef00760065000a00",
  },
  utf16be_bom: {
    encoding: "utf-16be",
    text: "1\n00:00:01,000 --> 00:00:04,000\nCafé résumé naïve\n",
    hex: "feff0031000a00300030003a00300030003a00300031002c0030003000300020002d002d003e002000300030003a00300030003a00300034002c003000300030000a00430061006600e90020007200e900730075006d00e90020006e006100ef00760065000a",
  },
  gbk_long: {
    encoding: "gbk",
    text: "1\n00:00:01,000 --> 00:00:02,000\n龙卷风席卷了整个村庄，居民们惊慌失措地逃离家园。\n警察和消防员迅速赶到现场，疏散群众并搜寻幸存者。\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300ac1fabeedb7e7cfafbeedc1cbd5fbb8f6b4e5d7afa3acbed3c3f1c3c7beaabbc5caa7b4ebb5d8ccd3c0ebbcd2d4b0a1a30abeafb2ecbacdcffbb7c0d4b1d1b8cbd9b8cfb5bdcfd6b3a1a3accae8c9a2c8bad6dab2a2cbd1d1b0d0d2b4e6d5dfa1a30a",
  },
  big5_long: {
    encoding: "big5",
    text: "1\n00:00:01,000 --> 00:00:02,000\n颱風席捲了整個村莊，居民們驚慌失措地逃離家園。\n警察和消防員迅速趕到現場，疏散群眾並搜尋倖存者。\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300abbe4adb7ae75b1b2a446bee3add3a7f8b2f8a141a97ea5c1adccc5e5b757a5a2b1b9a661b06bc2f7ae61b6e9a1430ac4b5b9eea94daef8a8beadfba8b3b374bbb0a8ecb27bb3f5a141b2a8b4b2b873b2b3a8c3b76ab44dadc6a673aacca1430a",
  },
  gbk_bilingual: {
    encoding: "gbk",
    text: "1\n00:00:01,000 --> 00:00:02,000\nHello, how are you doing today my friend?\n你好吗\n\n2\n00:00:03,000 --> 00:00:04,000\nI have not seen you in a long time.\n好久不见\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300a48656c6c6f2c20686f772061726520796f7520646f696e6720746f646179206d7920667269656e643f0ac4e3bac3c2f00a0a320a30303a30303a30332c303030202d2d3e2030303a30303a30342c3030300a492068617665206e6f74207365656e20796f7520696e2061206c6f6e672074696d652e0abac3bec3b2bbbcfb0a",
  },
  sjis_kanji: {
    encoding: "shift_jis",
    text: "1\n00:00:01,000 --> 00:00:02,000\n東京都新宿区西新宿二丁目八番一号都庁第一本庁舎。\n昨日未明火災発生、消防隊出動。\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300a938c8b9e937390568f688be690bc90568f6893f1929a96da94aa94d488ea8d86937392a191e688ea967b92a18ec981420a8df093fa96a296be89ce8dd094ad90b681418fc1966891e08f6f93ae81420a",
  },
  sjis_long: {
    encoding: "shift_jis",
    text: "1\n00:00:01,000 --> 00:00:02,000\n警察は事件現場に到着し、目撃者の証言を聞きました。\n容疑者はまだ逮捕されていません。\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300a8c788e4082cd8e968c8f8cbb8fea82c9939e928582b5814196da8c828ed282cc8fd88cbe82f095b782ab82dc82b582bd81420a97658b5e8ed282cd82dc82be91df95df82b382ea82c482a282dc82b982f181420a",
  },
  euckr_long: {
    encoding: "euc-kr",
    text: "1\n00:00:01,000 --> 00:00:02,000\n경찰관들은 사건 현장에 도착하여 목격자들의 진술을 들었습니다.\n용의자는 아직 체포되지 않았습니다.\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300ab0e6c2fbb0fcb5e9c0ba20bbe7b0c720c7f6c0e5bfa120b5b5c2f8c7cfbfa920b8f1b0ddc0dab5e9c0c720c1f8bcfac0bb20b5e9befabdc0b4cfb4d92e0abfebc0c7c0dab4c220bec6c1f720c3bcc6f7b5c7c1f620becabed2bdc0b4cfb4d92e0a",
  },
  cp1251_upper: {
    encoding: "windows-1251",
    text: "1\n00:00:01,000 --> 00:00:02,000\nВНИМАНИЕ! ВСЕМ ПОКИНУТЬ ЗДАНИЕ НЕМЕДЛЕННО.\nЭто не учебная тревога.\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300ac2cdc8ccc0cdc8c52120c2d1c5cc20cfcecac8cdd3d2dc20c7c4c0cdc8c520cdc5ccc5c4cbc5cdcdce2e0addf2ee20ede520f3f7e5e1ede0ff20f2f0e5e2eee3e02e0a",
  },
  cp1251_long: {
    encoding: "windows-1251",
    text: "1\n00:00:01,000 --> 00:00:02,000\nПолиция быстро прибыла на место происшествия и начала опрашивать свидетелей.\nПодозреваемый пока не задержан.\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300acfeeebe8f6e8ff20e1fbf1f2f0ee20eff0e8e1fbebe020ede020ece5f1f2ee20eff0eee8f1f8e5f1f2e2e8ff20e820ede0f7e0ebe020eeeff0e0f8e8e2e0f2fc20f1e2e8e4e5f2e5ebe5e92e0acfeee4eee7f0e5e2e0e5ecfbe920efeeeae020ede520e7e0e4e5f0e6e0ed2e0a",
  },
  koi8u_uk: {
    encoding: "koi8-u",
    text: "1\n00:00:01,000 --> 00:00:02,000\nПривіт, як справи? Все добре, дякую.\nПоліція швидко прибула на місце події.\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300af0d2c9d7a6d42c20d1cb20d3d0d2c1d7c93f20f7d3c520c4cfc2d2c52c20c4d1cbd5c02e0af0cfcca6c3a6d120dbd7c9c4cbcf20d0d2c9c2d5ccc120cec120cda6d3c3c520d0cfc4a6a72e0a",
  },
  cp1252_name: {
    encoding: "windows-1252",
    text: "1\n00:00:01,000 --> 00:00:02,000\nI met José at the café yesterday.\nHe said naïve things about the résumé.\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300a49206d6574204a6f73e92061742074686520636166e9207965737465726461792e0a48652073616964206e61ef7665207468696e67732061626f7574207468652072e973756de92e0a",
  },
  cp1252_one: {
    encoding: "windows-1252",
    text: "1\n00:00:01,000 --> 00:00:02,000\nHello, it's Zoë.\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300a48656c6c6f2c2069742773205a6feb2e0a",
  },
  cp1252_dash: {
    encoding: "windows-1252",
    text: "1\n00:00:01,000 --> 00:00:02,000\nWait — what? I didn't say that…\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300a57616974209720776861743f2049206469646e2774207361792074686174850a",
  },
  cp1252_it: {
    encoding: "windows-1252",
    text: "1\n00:00:01,000 --> 00:00:02,000\nÈ già tardi, perché non sei venuto? Più tardi, forse.\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300ac8206769e02074617264692c207065726368e9206e6f6e207365692076656e75746f3f205069f92074617264692c20666f7273652e0a",
  },
  cp1252_pt: {
    encoding: "windows-1252",
    text: "1\n00:00:01,000 --> 00:00:02,000\nNão sei o que aconteceu, mas a situação está sob controle.\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300a4ee36f20736569206f207175652061636f6e74656365752c206d61732061207369747561e7e36f20657374e120736f6220636f6e74726f6c652e0a",
  },
  cp1252_fr_long: {
    encoding: "windows-1252",
    text: "1\n00:00:01,000 --> 00:00:02,000\nLa police est arrivée rapidement sur les lieux et a commencé à interroger les témoins.\nLe suspect n'a pas encore été arrêté.\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300a4c6120706f6c69636520657374206172726976e965207261706964656d656e7420737572206c6573206c69657578206574206120636f6d6d656e63e920e020696e746572726f676572206c65732074e96d6f696e732e0a4c652073757370656374206e27612070617320656e636f726520e974e920617272ea74e92e0a",
  },
  cp1250_sk: {
    encoding: "windows-1250",
    text: "1\n00:00:01,000 --> 00:00:02,000\nĽúbim ťa, povedal som jej včera večer.\nNeodpovedala, iba sa usmiala.\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300abcfa62696d209d612c20706f766564616c20736f6d206a656a2076e8657261207665e865722e0a4e656f64706f766564616c612c206962612073612075736d69616c612e0a",
  },
  cp1250_hr: {
    encoding: "windows-1250",
    text: "1\n00:00:01,000 --> 00:00:02,000\nPolicija je brzo stigla na mjesto događaja i počela ispitivati svjedoke.\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300a506f6c6963696a61206a652062727a6f20737469676c61206e61206d6a6573746f20646f6761f0616a61206920706fe8656c6120697370697469766174692073766a65646f6b652e0a",
  },
  latin2_pl: {
    encoding: "iso-8859-2",
    text: "1\n00:00:01,000 --> 00:00:02,000\nZaproś ich wszystkich, ciągle czekają na odpowiedź.\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300a5a6170726fb6206963682077737a7973746b6963682c206369b1676c6520637a656b616ab1206e61206f64706f77696564bc2e0a",
  },
  cp1253_mixed: {
    encoding: "windows-1253",
    text: "1\n00:00:01,000 --> 00:00:02,000\nΚαλημέρα! Τι κάνεις σήμερα;\nΗ αστυνομία έφτασε γρήγορα.\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300acae1ebe7ecddf1e12120d4e920eadcede5e9f220f3deece5f1e13b0ac720e1f3f4f5edefecdfe120ddf6f4e1f3e520e3f1dee3eff1e12e0a",
  },
  cp1256_long: {
    encoding: "windows-1256",
    text: "1\n00:00:01,000 --> 00:00:02,000\nالشرطة وصلت إلى مكان الحادث بسرعة وبدأت التحقيق مع الشهود.\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300ac7e1d4d1d8c920e6d5e1ca20c5e1ec20e3dfc7e420c7e1cdc7cfcb20c8d3d1dac920e6c8cfc3ca20c7e1cacddeedde20e3da20c7e1d4e5e6cf2e0a",
  },
  cp1255_long: {
    encoding: "windows-1255",
    text: "1\n00:00:01,000 --> 00:00:02,000\nהמשטרה הגיעה למקום האירוע במהירות והחלה לחקור את העדים.\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300ae4eef9e8f8e420e4e2e9f2e420eceef7e5ed20e4e0e9f8e5f220e1eee4e9f8e5fa20e5e4e7ece420ece7f7e5f820e0fa20e4f2e3e9ed2e0a",
  },
  cp874_long: {
    encoding: "windows-874",
    text: "1\n00:00:01,000 --> 00:00:02,000\nตำรวจมาถึงที่เกิดเหตุอย่างรวดเร็วและเริ่มสอบปากคำพยาน\nผู้ต้องสงสัยยังไม่ถูกจับกุม\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300ab5d3c3c7a8c1d2b6d6a7b7d5e8e0a1d4b4e0cbb5d8cdc2e8d2a7c3c7b4e0c3e7c7e1c5d0e0c3d4e8c1cacdbabbd2a1a4d3bec2d2b90abcd9e9b5e9cda7caa7cad1c2c2d1a7e4c1e8b6d9a1a8d1baa1d8c10a",
  },
  cp1254_long: {
    encoding: "windows-1254",
    text: "1\n00:00:01,000 --> 00:00:02,000\nPolis olay yerine hızla ulaştı ve tanıkları sorgulamaya başladı.\nŞüpheli henüz yakalanmadı.\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300a506f6c6973206f6c617920796572696e652068fd7a6c6120756c61fe74fd2076652074616efd6b6c6172fd20736f7267756c616d617961206261fe6c6164fd2e0adefc7068656c692068656efc7a2079616b616c616e6d6164fd2e0a",
  },
  cp1257_lt: {
    encoding: "windows-1257",
    text: "1\n00:00:01,000 --> 00:00:02,000\nPolicija greitai atvyko į įvykio vietą ir pradėjo apklausti liudininkus.\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300a506f6c6963696a61206772656974616920617476796b6f20e120e176796b696f2076696574e02069722070726164eb6a6f2061706b6c6175737469206c697564696e696e6b75732e0a",
  },
  cp1252_de_long: {
    encoding: "windows-1252",
    text: "1\n00:00:01,000 --> 00:00:02,000\nDie Polizei traf schnell am Tatort ein und begann, Zeugen zu befragen.\nDer Verdächtige wurde noch nicht gefasst, sagte der Bürgermeister.\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300a44696520506f6c697a65692074726166207363686e656c6c20616d205461746f72742065696e20756e6420626567616e6e2c205a657567656e207a7520626566726167656e2e0a4465722056657264e4636874696765207775726465206e6f6368206e6963687420676566617373742c207361677465206465722042fc726765726d6569737465722e0a",
  },
  cp1252_es_long: {
    encoding: "windows-1252",
    text: "1\n00:00:01,000 --> 00:00:02,000\nLa policía llegó rápidamente al lugar y comenzó a interrogar a los testigos.\n¿Dónde está el sospechoso? ¡No lo sé!\n",
    hex: "310a30303a30303a30312c303030202d2d3e2030303a30303a30322c3030300a4c6120706f6c6963ed61206c6c6567f32072e1706964616d656e746520616c206c75676172207920636f6d656e7af3206120696e746572726f6761722061206c6f73207465737469676f732e0abf44f36e646520657374e120656c20736f73706563686f736f3f20a14e6f206c6f2073e9210a",
  },
  tiny_1252: { encoding: "windows-1252", text: "Zoë\n", hex: "5a6feb0a" },
  gbk_short: { encoding: "gbk", text: "你好\n", hex: "c4e3bac30a" },
  big5_short: { encoding: "big5", text: "你好嗎\n", hex: "a741a66eb6dc0a" },
};

export function bytesOf(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
