# Инструкция: заливка проекта в Git/GitHub

## 1. Инициализация Git (если еще не инициализирован)
```bash
cd /Users/orca/Local/web-radio
git init
```

## 2. Проверка статуса
```bash
git status
```

## 3. Добавить все файлы и сделать первый коммит
```bash
git add .
git commit -m "Initial commit"
```

## 4. Создать пустой репозиторий на GitHub
Создайте репозиторий через GitHub UI (без README/.gitignore/license).

## 5. Привязать удаленный репозиторий
```bash
git remote add origin https://github.com/<USERNAME>/<REPO>.git
```

Если `origin` уже существует:
```bash
git remote set-url origin https://github.com/<USERNAME>/<REPO>.git
```

## 6. Переименовать основную ветку в `main` и отправить
```bash
git branch -M main
git push -u origin main
```

## 7. Дальше обычный цикл работы
```bash
git add .
git commit -m "Краткое описание изменений"
git push
```

## Полезные проверки
```bash
git remote -v
git branch
git log --oneline --decorate -n 10
```
