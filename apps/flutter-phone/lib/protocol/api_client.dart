import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

class ApiException implements Exception {
  ApiException(this.message);
  final String message;
  @override
  String toString() => message;
}

class BackendOption {
  BackendOption(this.id, this.detail, this.missing);
  final String id;
  final String detail;
  final List<String> missing;
}

class ServerInfo {
  ServerInfo(this.defaultBackend, this.backends);
  final String defaultBackend;
  final List<BackendOption> backends;
}

class ScenarioChoice {
  ScenarioChoice({required this.id, required this.latest, required this.ready, required this.title, required this.firstUtterance});
  final String id;
  final int? latest;
  final List<int> ready;
  final String title;
  final String firstUtterance;
}

class SessionInfo {
  SessionInfo(this.raw);
  final Map<String, dynamic> raw;
  String get sessionId => raw['session_id'] as String;
  int get version => (raw['version'] as num).toInt();
  String get backend => '${raw['backend']}';
  bool get mockRealtime => raw['mock_realtime'] == true;
  bool get bargeInEnabled => raw['barge_in_enabled'] == true;
  String get entryAudioId => raw['entry_audio_id'] as String;
}

/// HTTP side of the contract (docs/API_EVENTS.md). Pure dart:io, no plugins.
/// Every request carries `Origin`; POSTs carry `application/json` and a Content-Length
/// (the server's guard middleware rejects chunked bodies).
class PhoneApi {
  PhoneApi(String server, {this.auth, HttpClient? client})
      : server = server.trim().replaceAll(RegExp(r'/+$'), ''),
        _client = client ?? HttpClient() {
    _client.connectionTimeout = const Duration(seconds: 10);
  }

  final String server;
  final String? auth; // "user:pass" (Basic), optional
  final HttpClient _client;

  String get origin => Uri.parse(server).origin;

  Map<String, String> get headers => {
        'origin': origin,
        if (auth != null) 'authorization': 'Basic ${base64.encode(utf8.encode(auth!))}',
      };

  String get wsBase => server.replaceFirst(RegExp(r'^http'), 'ws');

  Future<(int, Uint8List)> _request(String method, String path, [Object? body]) async {
    final req = await _client.openUrl(method, Uri.parse('$server$path'));
    headers.forEach(req.headers.set);
    if (body != null) {
      final bytes = utf8.encode(jsonEncode(body));
      req.headers.set('content-type', 'application/json');
      req.contentLength = bytes.length;
      req.add(bytes);
    }
    final res = await req.close();
    final b = BytesBuilder(copy: false);
    await for (final c in res) {
      b.add(c);
    }
    return (res.statusCode, b.takeBytes());
  }

  Future<dynamic> _json(String method, String path, [Object? body]) async {
    final (code, bytes) = await _request(method, path, body);
    final text = utf8.decode(bytes, allowMalformed: true);
    if (code < 200 || code >= 300) {
      throw ApiException('$method $path → HTTP $code ${text.length > 300 ? text.substring(0, 300) : text}');
    }
    return text.isEmpty ? null : jsonDecode(text);
  }

  Future<ServerInfo> config() async {
    final cfg = await _json('GET', '/api/config') as Map<String, dynamic>;
    final db = cfg['decision_backends'] as Map<String, dynamic>;
    return ServerInfo(
      '${db['default']}',
      [
        for (final o in (db['options'] as List).cast<Map<String, dynamic>>())
          BackendOption('${o['id']}', '${o['detail'] ?? ''}', ((o['missing'] as List?) ?? const []).map((e) => '$e').toList()),
      ],
    );
  }

  /// Same data as `phone.ts --list --json`: scenarios that have a READY version.
  Future<List<ScenarioChoice>> listScenarios() async {
    final list = ((await _json('GET', '/api/scenarios') as Map)['scenarios'] as List).cast<Map<String, dynamic>>();
    final out = <ScenarioChoice>[];
    for (final s in list) {
      final id = s['scenario_id'] as String;
      final versions = ((await _json('GET', '/api/scenarios/$id/versions') as Map)['versions'] as List).cast<Map<String, dynamic>>();
      final ready = [for (final v in versions) if (v['status'] == 'READY') (v['version'] as num).toInt()]..sort();
      var title = '';
      var first = '';
      if (ready.isNotEmpty) {
        final row = await _json('GET', '/api/scenarios/$id/versions/${ready.last}') as Map<String, dynamic>;
        final sc = row['scenario'] as Map<String, dynamic>?;
        title = '${sc?['title'] ?? ''}';
        final entry = sc?['entry_node_id'];
        for (final n in ((sc?['nodes'] as List?) ?? const []).cast<Map<String, dynamic>>()) {
          if (n['id'] == entry) first = '${n['assistant_text'] ?? ''}';
        }
      }
      out.add(ScenarioChoice(id: id, latest: (s['latest'] as num?)?.toInt(), ready: ready, title: title, firstUtterance: first));
    }
    return out;
  }

  Future<SessionInfo> createSession({required String scenarioId, required int version, Map<String, dynamic> runtime = const {}}) async {
    final m = await _json('POST', '/api/sessions', {
      'scenario_id': scenarioId,
      'version': version,
      'request_id': 'fl${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}',
      'runtime': runtime,
    });
    return SessionInfo(m as Map<String, dynamic>);
  }

  Future<Uint8List> fetchAudio(String audioId) async {
    final (code, bytes) = await _request('GET', '/api/audio/$audioId');
    if (code != 200) throw ApiException('HTTP $code');
    return bytes;
  }

  Future<String> sessionLog(String sessionId) async {
    final (code, bytes) = await _request('GET', '/api/sessions/$sessionId/log.jsonl');
    if (code != 200) throw ApiException('HTTP $code');
    return utf8.decode(bytes);
  }

  void close() => _client.close(force: true);
}
