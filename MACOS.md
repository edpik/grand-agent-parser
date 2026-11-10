# Запуск на macOS

Для MacBook Air M4 используйте [DMG для Apple Silicon из релиза v0.5.0](https://github.com/edpik/grand-agent-parser/releases/tag/v0.5.0). Перенесите Grand CSV в папку «Программы». Python и Node.js для установленного приложения не нужны. Ограничения GSDX сохраняются. [Пошаговая инструкция, включая первый запуск macOS](DESKTOP.md).

# Запуск на MacBook Air M4

Для преобразования смет в CSV можно сразу открыть веб-интерфейс: https://grand-csv-converter.ed-pik.chatgpt.site. Для него установка Python не нужна. Поддерживаются открытые GSFX/XML и частичный экспорт GSDX (каталог, структура, технические тексты); старый двоичный GSF требует предварительного XML-экспорта.

В релизе v0.2.0 и новее доступна готовая статическая сборка `web/dist`. Из распакованной папки проекта её можно открыть локально:

```bash
python3 -m http.server 8080 --bind 127.0.0.1 --directory web/dist
```

Затем откройте http://127.0.0.1:8080. Далее описан запуск CLI-парсера.

Нужен Python 3.10 или новее. Код использует стандартную библиотеку Python и SQLite FTS5. Rosetta и программа «ГРАНД-Смета» для запуска парсера не нужны.

1. Скачайте ZIP `grand_agent_parser_0.1.0.zip` из релиза `v0.1.0` этого репозитория и распакуйте его в «Загрузках».
2. Откройте «Терминал» и проверьте Python:

```bash
python3 --version
```

Если Python отсутствует или его версия ниже 3.10, установите подходящую версию с https://www.python.org/downloads/macos/.

3. Перейдите в распакованную папку:

```bash
cd ~/Downloads/grand_agent_parser
```

4. Проверьте формат своего файла, затем выполните импорт:

```bash
python3 -m grand_parser inspect ~/Downloads/"nb105420 2.gsdx"
python3 -m grand_parser parse ~/Downloads/"nb105420 2.gsdx" --output result
```

Если ваш файл находится в другой папке, укажите его фактический путь. Каталог `result` должен быть новым.

5. Найдите фрагменты по теме:

```bash
python3 -m grand_parser search result/grand.sqlite "корроз"
```

Результаты — JSONL, SQLite и `manifest.json` — находятся в `result`.

## Проверка на искусственном примере без своей базы

```bash
python3 -m grand_parser parse examples/synthetic_estimate.gsfx --output demo
python3 -m grand_parser lookup demo/grand.sqlite TEST-001
```

## Ограничение GSDX

Из GSDX извлекаются каталог, оглавления и доступные технические тексты. Числовые бинарные блоки расценок и ресурсов GSDX не декодированы. Статус `partial` ожидаем и отражён в отчёте. Нормы и расходы ресурсов можно импортировать отдельным адаптером открытого XML ФСНБ; это не замена территориальных расценок.
