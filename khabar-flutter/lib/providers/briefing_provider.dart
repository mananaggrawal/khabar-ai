import 'package:flutter/foundation.dart';
import '../models/briefing.dart';
import '../services/auth_service.dart';
import '../services/briefing_service.dart';

enum BriefingStatus { idle, loading, ready, error }

class BriefingProvider extends ChangeNotifier {
  final AuthService _auth;
  final BriefingService _service;

  BriefingProvider(this._auth, this._service);

  BriefingStatus _status = BriefingStatus.idle;
  DailyBriefing? _briefing;
  String? _error;
  String _activeSection = 'headlines';

  BriefingStatus get status => _status;
  DailyBriefing? get briefing => _briefing;
  String? get error => _error;
  String get activeSection => _activeSection;

  List<Story> get activeStories =>
      _briefing?.storiesForSection(_activeSection) ?? [];

  void setSection(String section) {
    _activeSection = section;
    notifyListeners();
  }

  Future<void> load() async {
    final token = _auth.accessToken;
    if (token == null) {
      _error = 'Not signed in';
      _status = BriefingStatus.error;
      notifyListeners();
      return;
    }
    _status = BriefingStatus.loading;
    _error = null;
    notifyListeners();

    try {
      _briefing = await _service.fetchBriefing(token);
      // Default to first available section
      if (_briefing!.sections.isNotEmpty &&
          !_briefing!.sections.contains(_activeSection)) {
        _activeSection = _briefing!.sections.first;
      }
      _status = BriefingStatus.ready;
    } catch (e) {
      _error = e.toString();
      _status = BriefingStatus.error;
    }
    notifyListeners();
  }
}
