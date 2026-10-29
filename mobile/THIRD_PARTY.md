# Сторонние компоненты

- MediaPipe Tasks Vision **1.1.1**, Google. Apache License 2.0, текст в `app/vendor/LICENSE-mediapipe.txt`. Исходный пакет: https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-1.1.1.tgz . Код и WASM сохранены локально, без изменений.
- Pose Landmarker Lite (float16, version 1), Google MediaPipe. Файл https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task . Готовая модель оценки позы, не модель, обученная автором курсового проекта. Документация: https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker .
- Видеопример: Frank C. Müller, «Liegestuetz02 ani fcm.gif», CC BY-SA 4.0. Источник, лицензия и внесённые изменения перечислены в `app/samples/ATTRIBUTION.txt`. Адаптированная фотографическая последовательность распространяется по CC BY-SA 4.0; он не является независимой тестовой выборкой.
- Android SDK platform 35 / build-tools 35.0.0 используются только для сборки. В APK включён собственный Java-код оболочки, а не Android SDK. Материалы SDK сохраняются отдельно от исходников приложения.

APK содержит все ресурсы модели. Нет аналитики, рекламы, удалённого API распознавания или загрузки видео на сервер. Записи камеры не сохраняются. История хранит только выбранное упражнение, численный результат и дату на данном устройстве; её можно очистить.

## Видео планки, добавлено в 0.1.3

Forearm Plank — SSgt Randall Moose / U.S. Air Force, 2021-12-13.
https://www.dvidshub.net/video/825280/forearm-plank — Public domain по странице источника; условия https://www.dvidshub.net/about/copyright.
Фрагмент 5–17 с, без звука, уменьшен до 640 px, H.264. Скорость не изменена. Использование не означает поддержку приложения автором или ведомством. Атрибуция также включена в APK.
