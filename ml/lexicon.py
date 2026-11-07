"""Мультиязычные (RU/KZ/EN) паттерны для retriever и rule-based fallback.

KZ НЕ переводим: паттерны написаны на казахском напрямую.
TODO(hackathon): лексиконы собраны по DEV-набору, на контрольном могут промахиваться — LLM-судья важнее.
"""
import re

F = re.IGNORECASE | re.UNICODE


def rx(*parts: str) -> re.Pattern:
    return re.compile("|".join(f"(?:{p})" for p in parts), F)


GREETING = rx(
    r"здравств", r"добр(ый|ое|ого)\s+(день|вечер|утр)", r"приветству", r"\bпривет", r"доброго\s+времени",
    r"сәлем", r"салем", r"қайырлы\s+(күн|таң|кеш)", r"армысыз",
    r"\bhello\b", r"\bhi\b", r"\bhey\b", r"good\s+(morning|afternoon|evening|day)", r"\bgreetings\b",
)

INTRO = rx(
    r"меня\s+зовут", r"мо[её]\s+имя", r"с\s+вами\s+\w+", r"на\s+связи", r"\[имя скрыто\]",
    r"менің\s+атым", r"атым\s+\w+",
    r"my\s+name\s+is", r"you'?re\s+chatting\s+with",
)
# Представление «я Алина» / «мен Дана» / «I'm Chris»: регистр важен (имя с заглавной), поэтому без IGNORECASE
INTRO_NAME = re.compile(
    r"(?:(?:^|[\s,.!])[Яя]\s*[—-]?\s+[А-ЯЁ][а-яё]+)"
    r"|(?:(?:^|[\s,.!])[Мм]ен\s+[А-ЯӘҒҚҢӨҰҮҺІ][а-яәғқңөұүһі]+)"
    r"|(?:\b(?:I'?m|I\s+am|[Tt]his\s+is)\s+[A-Z][a-z]+)",
    re.UNICODE,
)

HELP_OFFER = rx(
    r"чем\s+(я\s+)?могу\s+помочь", r"чем\s+помочь", r"қалай\s+көмектесе", r"сізге\s+қалай\s+көмек",
    r"how\s+(can|may)\s+i\s+help", r"what\s+can\s+i\s+do\s+for\s+you",
)

CLARIFY = rx(
    r"уточни", r"подскажите", r"какой|какую|каким|какая|какое|каком", r"когда\s+(вы|был|была)", r"сколько",
    r"\bқай\b|қайсы|қашан|қандай|қанша|нақтылаңыз",
    r"\bwhich\b", r"\bwhen\b", r"\bwhat\b", r"could\s+you\s+(tell|specify|clarify|confirm)", r"\bhow\s+much\b",
)

VERIFIED = rx(
    r"личност\w*\s+(клиента\s+)?подтвержд", r"идентификац\w*\s+(успешно\s+)?(пройден|выполнен|подтвержд)", r"верифицирован", r"верификац\w*\s+пройден",
    r"клиент\s+(успешно\s+)?(идентифицирован|верифицирован)",
    r"жеке\s+бас\w*\s+расталд", r"сәйкестендір\w*\s+(өтті|расталд)",
    r"identity\s+(was\s+|has\s+been\s+)?(verified|confirmed)", r"verification\s+(passed|successful|completed)", r"client\s+(was\s+)?verified",
)

VERIFY_REQUEST = rx(
    r"подтверд\w*\s+(ваш\w*\s+)?(личност|данные)", r"нужно\s+(вас\s+)?(идентифицир|верифицир)", r"пройдите\s+(идентификац|верификац)",
    r"кодовое\s+слово", r"назовите\s+(ваш\w*\s+)?(фио|дату\s+рождения|иин)",
    r"жеке\s+бас\w*\s+раста", r"растау\s+қажет", r"сәйкестендіру",
    r"verify\s+your\s+identity", r"confirm\s+your\s+identity", r"identity\s+verification", r"security\s+question",
)

ACCOUNT_DISCLOSURE = rx(
    r"ваш\w*\s+(баланс|остаток|платеж|платёж|перевод|заявк\w*|поручени\w*)\s+(состав|поступ|зачисл|исполн|отклон|в\s+обработке|обработан)",
    r"на\s+вашем\s+сч[её]те", r"(я\s+)?(проверил|проверила|посмотрел|посмотрела|вижу)\s+(по\s+)?ваш", r"по\s+вашему\s+сч[её]ту",
    r"шотыңызда", r"сіздің\s+(шот|төлем|аударым)\w*\s+(түсті|көрінеді|өңдел)", r"тексердім", r"көріп\s+тұрмын",
    r"your\s+(balance|payment|transfer|deposit|withdrawal|order)\s+(is|was|has|shows)", r"i\s+(can\s+)?see\s+(that\s+)?your", r"i('ve|\s+have)?\s+checked\s+your",
    r"on\s+your\s+account\s+(there|i)",
)

INSTRUCTION = rx(
    r"откройте", r"перейдите", r"выберите", r"нажмите", r"зайдите", r"укажите", r"в\s+раздел", r"вкладк", r"меню", r"→",
    r"оформ(ите|лю)", r"подайте", r"заполните", r"обратитесь", r"скачайте", r"проверьте",
    r"передам", r"направлю", r"специалист\w*\s+(свяж|ответ|провер)", r"заявк\w*\s+(создан|оформлен|зарегистр)",
    r"ашыңыз", r"таңдаңыз", r"басыңыз", r"бөлім", r"өтіңіз", r"көрсетіп", r"жүктеңіз", r"жолдаймын", r"мамандар",
    r"\bgo\s+to\b", r"\bopen\b", r"\bselect\b", r"\bclick\b", r"\btap\b", r"\bnavigate\b", r"\bsubmit\b", r"\bmenu\b",
    r"i('ll|\s+will)\s+(forward|escalate|pass|create|submit)", r"\bfill\s+(in|out)\b", r"\bcheck\b",
)

COMPLAINT = rx(
    r"недовол", r"возмущ", r"ужас", r"безобраз", r"сколько\s+можно", r"(уже|опять)\s+(второй|третий|который)", r"долго",
    r"не\s+работает", r"не\s+могу", r"не\s+получается", r"проблем", r"жалоб", r"плохо", r"не\s+приш[её]л", r"не\s+поступ", r"не\s+видно", r"пропал",
    r"алаң", r"ренж", r"көрінбей", r"түспей", r"істемей", r"болмай\s+тұр", r"қашанға\s+дейін",
    r"frustrat", r"annoy", r"terrible", r"ridiculous", r"still\s+(not|haven)", r"doesn'?t\s+work", r"can'?t", r"won'?t\s+let", r"problem", r"complain",
    r"unacceptable", r"not\s+(received|arrived|showing)",
)

EMPATHY = rx(
    r"понима(ю|ем)", r"сожале", r"извин", r"прош\w+\s+прощени", r"неприятн", r"сочувств", r"разберемся|разберёмся", r"благодар\w+\s+за\s+терпени",
    r"түсінемін|түсінікті", r"кешіріңіз", r"өкінішті", r"алаңдай",
    r"\bsorry\b", r"understand", r"apolog", r"i\s+see\s+how", r"frustrating", r"thank\s+you\s+for\s+your\s+patience",
)

REASK = rx(
    r"в\s+смысле", r"не\s+понял", r"не\s+поняла", r"непонятно", r"в\s+как\w+\s+(меню|раздел\w*|вкладк\w*)\s*\?", r"где\s+именно",
    r"что\s+(это\s+)?значит", r"повторите", r"куда\s+(именно\s+)?(нажать|зайти)", r"так\s+где",
    r"түсінбедім", r"қай\s+(мәзір|жер|бөлім|жерде)\w*\s*\?", r"нені\s+айтып",
    r"what\s+do\s+you\s+mean", r"which\s+(menu|one|section)\s*\?", r"where\s+exactly", r"i\s+don'?t\s+understand", r"didn'?t\s+get", r"sorry\s*\?",
    # короткий переспрос «Settings where?» / «Меню где?» / «Мәзір қайда?»
    r"^\s*\w+\s+(where|где|қайда)\s*\?",
)

# клиент указывает, что уже сообщал эти данные -> оператор не учёл известные детали
ALREADY_SAID = rx(
    r"(я\s+)?(же\s+)?уже\s+(писал|написал|писала|написала|говорил|говорила|сказал|сказала|указал|указала)", r"выше\s+(писал|написал|указал)",
    r"жоғарыда\s+(жаздым|айттым)", r"жаздым\s+ғой", r"айттым\s+ғой",
    r"(i\s+)?already\s+(said|told|wrote|mentioned)", r"as\s+i\s+(said|mentioned)", r"i\s+told\s+you",
)

# клиент повторяет свой вопрос -> ответа по существу не было
REPEAT_Q = rx(
    r"я\s+(же\s+)?спрашива(ю|л|ла)", r"я\s+(же\s+)?спросил", r"вы\s+не\s+ответили", r"так\s+почему", r"а\s+причина",
    r"ал\s+себеб", r"сұрағыма\s+жауап", r"мен\s+сұрап\s+(тұрмын|отырмын)",
    r"i\s+(was\s+)?ask(ed|ing)\s+(why|about|you)", r"you\s+didn'?t\s+answer", r"but\s+why", r"so\s+why",
)

OP_GLITCH = rx(r"извините,\s+уточню", r"прошу\s+прощения,\s+(ошиб|неверн)", r"кешіріңіз,\s+нақтылаймын", r"sorry,\s+(let\s+me\s+)?correct")

WAIT_WARN = rx(
    r"(минут|секунд)\w*\s*(ожида|подожд)", r"ожидайте", r"подождите", r"одну\s+минут", r"мне\s+нужно\s+(время|проверить)",
    r"күте\s+тұрыңыз", r"бір\s+минут", r"please\s+wait", r"one\s+moment", r"give\s+me\s+a\s+(moment|minute)", r"bear\s+with\s+me",
)

FAREWELL = rx(
    r"до\s+свидания", r"всего\s+(доброго|хорошего)", r"хорошего\s+(дня|вечера|настроения)", r"удачного\s+дня", r"обращайтесь", r"спасибо\s+за\s+обращение",
    r"сау\s+болыңыз", r"келесі\s+кездескенше", r"күніңіз\s+сәтті", r"жақсы\s+күн", r"хабарласқаныңызға\s+рақмет",
    r"\bbye\b", r"goodbye", r"have\s+a\s+(good|great|nice)", r"thanks?\s+(you\s+)?for\s+contacting", r"take\s+care",
)

HELP_MORE = rx(
    r"(могу|можем)\s+(ли\s+)?(я\s+)?(ещ[её]\s+)?(чем-?то|чем\s+то)\s+(ещ[её]\s+)?помочь", r"ещ[её]\s+вопрос", r"остались\s+вопросы", r"что-?то\s+ещ[её]",
    r"тағы\s+(сұра|көмек)", r"басқа\s+сұра",
    r"anything\s+else", r"other\s+questions", r"(can|may)\s+i\s+help\s+(you\s+)?with\s+anything",
)

CLIENT_LEFT = rx(
    r"клиент\s+(покинул|вышел|завершил|закрыл|отключ)", r"чат\s+(закрыт|завершен|завершён)\s+клиент", r"соединение\s+(прервано|разорвано)",
    r"клиент\s+чаттан\s+шықты", r"байланыс\s+үзілді",
    r"client\s+(left|ended|closed|disconnected)", r"customer\s+(left|disconnected)", r"connection\s+(lost|dropped)",
)

INSULT = rx(
    r"\bдура[кч]", r"идиот", r"\bтуп(ой|ая|ые|ица)", r"бестолк", r"заткн", r"дебил", r"кретин", r"\bлох\b",
    r"ақымақ", r"миғұла", r"\bидиот",
    r"\bidiot", r"\bstupid\b", r"\bdumb\b", r"shut\s+up", r"moron",
    # унижение без брани: «вы вообще читать умеете?», «до вас не доходит»
    r"(вы|ты)\s+(вообще\s+)?(читать|думать|слушать)\s+(умеете|умеешь)", r"до\s+(вас|тебя)\s+не\s+доход", r"сколько\s+можно\s+повторять",
    r"оқи\s+алмайсыз\s+ба",
    r"can'?t\s+you\s+(even\s+)?read", r"are\s+you\s+(even\s+)?(able\s+to\s+read|deaf|blind)",
)

BYPASS = rx(
    r"переведите\s+(деньги\s+)?(мне|на\s+мою|на\s+мой)",
    # «скиньте/перекиньте/отправьте деньги мне на карту», «через компанию не надо»
    # только про деньги: «отправьте мне скриншот» — обычная просьба поддержки, не нарушение
    r"(скин|перекин|кин|отправ|перечисл|перевед)\w*\s+(\w+\s+){0,2}(деньги|средства|сумму)\s+(\w+\s+)?(мне|на\s+мою|на\s+мой)\b",
    r"мне\s+на\s+(карту|кошел[её]к|каспи)", r"через\s+компанию\s+(оформлять\s+)?не\s+(надо|нужно)", r"я\s+(сам|лично)\s+(их\s+)?влож",
    r"маған\s+ақша\s+(салыңыз|жіберіңіз|аударыңыз)", r"ақшаны\s+маған", r"менің\s+картама",
    r"send\s+(the\s+)?(money|funds)\s+to\s+(me|my)", r"to\s+my\s+(own\s+)?card", r"no\s+need\s+to\s+go\s+through\s+the\s+company",
r"на\s+мою\s+(личную\s+)?карт", r"мой\s+личный\s+(номер|сч[её]т|телефон|кош[её]л)",
    r"(ваш|свой)\s+(личный\s+)?(номер|телефон).{0,40}(консульт|whats|ватсап|телеграм|напишу|позвоню)", r"частн\w+\s+(платн\w+\s+)?консультац",
    r"напишите\s+мне\s+(лично|в\s+(whatsapp|ватсап|телеграм))", r"в\s+обход\s+компании", r"лично\s+(вам\s+)?(помогу|проконсультирую).{0,30}(за|плат|деньг)",
    r"жеке\s+(шотыма|картама|нөмір)", r"маған\s+(тікелей\s+)?аударыңыз", r"жеке\s+кеңес",
    r"transfer\s+(the\s+money\s+|it\s+|funds\s+)?(directly\s+)?to\s+me", r"my\s+personal\s+(account|card|number|wallet)",
    r"your\s+(personal\s+)?(phone\s+)?number.{0,40}(consult|whatsapp|telegram|call\s+you)", r"private\s+(paid\s+)?consult",
)

LEAK = rx(
    r"другого\s+клиента", r"другому\s+клиенту", r"пароль\w*\s*[:—-]\s*\S+", r"код\s+из\s+смс\s*[:—-]?\s*\d", r"номер\s+карты\s*[:—-]?\s*\d{4}",
    r"\bиин\s*[:—-]?\s*\d{12}\b", r"паспорт\w*\s*[:№—-]?\s*\d{6,}",
    r"басқа\s+клиент", r"another\s+client'?s", r"other\s+customer'?s", r"password\s+is", r"card\s+number\s+is\s+\d",
)

# Отличительные буквы казахского алфавита
KZ_LETTERS = re.compile(r"[әғқңөұүһіӘҒҚҢӨҰҮҺІ]")
CYR = re.compile(r"[а-яёА-ЯЁ]")
LAT = re.compile(r"[a-zA-Z]")
KZ_WORDS = rx(r"сәлем", r"рақмет", r"\bиә\b", r"\bжоқ\b", r"\bмен\b", r"сіз", r"қайырлы")


def detect_lang(text: str) -> str | None:
    if KZ_LETTERS.search(text) or KZ_WORDS.search(text):
        return "KZ"
    cyr, lat = len(CYR.findall(text)), len(LAT.findall(text))
    if cyr == 0 and lat == 0:
        return None
    # латиница в русском тексте часто = названия продуктов («Freedom Broker»), поэтому порог мягкий
    return "RU" if (cyr >= 15 or cyr >= lat) else "EN"
