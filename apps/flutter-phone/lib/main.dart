import 'package:flutter/material.dart';

import 'ui/phone_page.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const PhoneApp());
}

class PhoneApp extends StatelessWidget {
  const PhoneApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Audio Stroke Phone',
      theme: ThemeData(colorSchemeSeed: Colors.indigo, useMaterial3: true),
      home: const PhonePage(),
    );
  }
}
