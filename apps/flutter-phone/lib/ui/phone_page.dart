import 'dart:async';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../audio/device_audio.dart';
import '../protocol/api_client.dart';
import '../protocol/phone_client.dart';

const _prefServer = 'server_url';
const _maxLogLines = 2000;

/// The only screen: server URL, backend / scenario choice, start / stop / skip, and the log.
class PhonePage extends StatefulWidget {
  const PhonePage({super.key});

  @override
  State<PhonePage> createState() => _PhonePageState();
}

class _PhonePageState extends State<PhonePage> {
  final _server = TextEditingController();
  final _scroll = ScrollController();
  final List<String> _lines = [];

  ServerInfo? _info;
  List<ScenarioChoice> _scenarios = [];
  String? _backend;
  String? _scenarioId;
  bool _bargeIn = false; // half-duplex by default
  bool _input48k = false;
  bool _loading = false;
  bool _running = false;
  PhoneClient? _client;

  @override
  void initState() {
    super.initState();
    SharedPreferences.getInstance().then((p) {
      if (mounted) _server.text = p.getString(_prefServer) ?? '';
    });
  }

  @override
  void dispose() {
    _server.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _log(String s) {
    if (!mounted) return;
    setState(() {
      _lines.add(s);
      if (_lines.length > _maxLogLines) _lines.removeRange(0, _lines.length - _maxLogLines);
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
    });
  }

  String _ts() => DateTime.now().toUtc().toIso8601String().substring(11, 23);
  void _note(String s) => _log('${_ts()} $s');

  Future<void> _saveServer() async => (await SharedPreferences.getInstance()).setString(_prefServer, _server.text.trim());

  Future<void> _load() async {
    final url = _server.text.trim();
    if (url.isEmpty) return _note('サーバー URL を入力してください');
    setState(() => _loading = true);
    final api = PhoneApi(url);
    try {
      await _saveServer();
      final info = await api.config();
      final all = await api.listScenarios();
      final ready = all.where((s) => s.ready.isNotEmpty).toList();
      setState(() {
        _info = info;
        _scenarios = ready;
        _backend = info.defaultBackend;
        _scenarioId = ready.isEmpty ? null : ready.first.id;
      });
      _note('server $url: decision default=${info.defaultBackend}');
      for (final o in info.backends) {
        _note('  backend ${o.id.padRight(10)} ${o.detail}${o.missing.isNotEmpty ? '  (missing: ${o.missing.join(', ')})' : ''}');
      }
      if (ready.isEmpty) _note('READY なシナリオがありません');
    } catch (e) {
      _note('error: $e');
    } finally {
      api.close();
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _start() async {
    final sc = _scenarios.where((s) => s.id == _scenarioId).firstOrNull;
    if (sc == null || _backend == null) return;
    final api = PhoneApi(_server.text.trim());
    final sink = _sinkFactory();
    setState(() => _running = true);
    try {
      await _saveServer();
      _note('server: ${api.server}  backend: $_backend  scenario: ${sc.id}');
      _note('---- 会話開始。最初の案内が流れたら話してください（${_bargeIn ? '割り込みあり' : '半二重: 再生中はマイク停止'}） ----');
      final session = await api.createSession(
        scenarioId: sc.id,
        version: sc.ready.last,
        runtime: {'decision_backend': _backend, if (_bargeIn) 'barge_in_enabled': true},
      );
      await configureConversationAudioSession();
      final client = PhoneClient(
        api: api,
        micSource: RecordAudioSource(sampleRate: _input48k ? 48000 : 24000),
        sink: sink,
        log: _log,
      );
      _client = client;
      await client.run(session);
    } catch (e) {
      _note('error: $e');
    } finally {
      _client = null;
      await sink.dispose();
      api.close();
      if (mounted) setState(() => _running = false);
    }
  }

  JustAudioSink _sinkFactory() => JustAudioSink();

  @override
  Widget build(BuildContext context) {
    final canStart = !_running && !_loading && _scenarioId != null && _backend != null;
    return Scaffold(
      appBar: AppBar(title: const Text('Audio Stroke Phone')),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(children: [
                Expanded(
                  child: TextField(
                    controller: _server,
                    enabled: !_running,
                    keyboardType: TextInputType.url,
                    autocorrect: false,
                    decoration: const InputDecoration(labelText: 'サーバー URL', hintText: 'http://100.x.y.z:8000', isDense: true),
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton.tonal(onPressed: _running || _loading ? null : _load, child: Text(_loading ? '…' : '読み込み')),
              ]),
              const SizedBox(height: 8),
              DropdownButtonFormField<String>(
                key: ValueKey('b-$_backend-${_info?.backends.length}'),
                initialValue: _backend,
                isExpanded: true,
                decoration: const InputDecoration(labelText: '判定バックエンド', isDense: true),
                items: [
                  for (final o in _info?.backends ?? <BackendOption>[])
                    DropdownMenuItem(
                      value: o.id,
                      child: Text(
                        '${o.id}${o.id == _info!.defaultBackend ? ' (既定)' : ''}${o.missing.isNotEmpty ? '  [未設定: ${o.missing.join(', ')}]' : ''}',
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                ],
                onChanged: _running ? null : (v) => setState(() => _backend = v),
              ),
              const SizedBox(height: 8),
              DropdownButtonFormField<String>(
                key: ValueKey('s-$_scenarioId-${_scenarios.length}'),
                initialValue: _scenarioId,
                isExpanded: true,
                decoration: const InputDecoration(labelText: 'シナリオ（READY）', isDense: true),
                items: [
                  for (final s in _scenarios)
                    DropdownMenuItem(
                      value: s.id,
                      child: Text(
                        '${s.title.isEmpty ? '(無題)' : s.title}  v${s.ready.last}  「${s.firstUtterance.length > 40 ? s.firstUtterance.substring(0, 40) : s.firstUtterance}」',
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                ],
                onChanged: _running ? null : (v) => setState(() => _scenarioId = v),
              ),
              Row(children: [
                Expanded(
                  child: SwitchListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    title: const Text('割り込み（要ヘッドセット）'),
                    value: _bargeIn,
                    onChanged: _running ? null : (v) => setState(() => _bargeIn = v),
                  ),
                ),
                Expanded(
                  child: SwitchListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    title: const Text('48kHz 入力'),
                    value: _input48k,
                    onChanged: _running ? null : (v) => setState(() => _input48k = v),
                  ),
                ),
              ]),
              Row(children: [
                Expanded(child: FilledButton(onPressed: canStart ? _start : null, child: const Text('開始'))),
                const SizedBox(width: 8),
                Expanded(child: OutlinedButton(onPressed: _running ? () => _client?.stop() : null, child: const Text('停止'))),
                const SizedBox(width: 8),
                Expanded(child: OutlinedButton(onPressed: _running ? () => _client?.skip() : null, child: const Text('再生スキップ'))),
              ]),
              const SizedBox(height: 8),
              Expanded(
                child: Container(
                  decoration: BoxDecoration(color: const Color(0xFF111111), borderRadius: BorderRadius.circular(6)),
                  padding: const EdgeInsets.all(6),
                  child: ListView.builder(
                    controller: _scroll,
                    itemCount: _lines.length,
                    itemBuilder: (_, i) => Text(
                      _lines[i],
                      style: const TextStyle(fontFamily: 'Menlo', fontFamilyFallback: ['monospace'], fontSize: 11, color: Color(0xFFDDDDDD)),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
