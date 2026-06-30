import 'dart:convert';
import 'package:http/http.dart' as http;
import '../models/briefing.dart';
import '../config.dart';

class BriefingService {
  /// Fetches today's briefing from the backend.
  /// Throws on error.
  Future<DailyBriefing> fetchBriefing(String accessToken) async {
    final uri = Uri.parse('${AppConfig.backendUrl}/api/briefing');
    final response = await http.get(
      uri,
      headers: {
        'Authorization': 'Bearer $accessToken',
        'Content-Type': 'application/json',
      },
    ).timeout(const Duration(seconds: 20));

    if (response.statusCode == 404) {
      throw const BriefingNotReadyException();
    }
    if (response.statusCode != 200) {
      throw BriefingFetchException(
        'Server returned ${response.statusCode}: ${response.body}',
      );
    }

    final json = jsonDecode(response.body) as Map<String, dynamic>;
    return DailyBriefing.fromJson(json);
  }
}

class BriefingNotReadyException implements Exception {
  const BriefingNotReadyException();
  @override
  String toString() => "Today's briefing is not ready yet. Check back soon.";
}

class BriefingFetchException implements Exception {
  final String message;
  const BriefingFetchException(this.message);
  @override
  String toString() => message;
}
