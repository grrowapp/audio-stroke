# flutter_phone

iPhone 用の Audio Stroke 電話クライアント（`cli/phone.ts` の Dart 移植）。構成・ビルド手順・未検証事項は [docs/FLUTTER_PHONE.md](../../docs/FLUTTER_PHONE.md)。

```
flutter pub get
flutter analyze
flutter test test/protocol
tool/run_integration.sh     # 実サーバー（mock）結合テスト
```
