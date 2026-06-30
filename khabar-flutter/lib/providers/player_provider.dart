import 'package:audio_service/audio_service.dart';
import 'package:flutter/foundation.dart';
import '../models/briefing.dart';
import '../services/audio_handler.dart';

class PlayerProvider extends ChangeNotifier {
  final KhabarAudioHandler _handler;

  Story? _currentStory;
  List<Story> _queue = [];
  bool _playerVisible = false;

  PlayerProvider(this._handler) {
    // Notify listeners whenever playback state changes (playing/paused/etc).
    _handler.playbackState.listen((_) => notifyListeners());
    _handler.mediaItem.listen((_) => notifyListeners());
  }

  Story? get currentStory => _currentStory;
  bool get playerVisible => _playerVisible;
  bool get isPlaying => _handler.playbackState.value.playing;
  KhabarAudioHandler get handler => _handler;

  MediaItem? get currentMediaItem => _handler.mediaItem.value;

  /// Load a list of stories and start playing from [startIndex].
  Future<void> playFrom(List<Story> stories, int startIndex) async {
    _queue = stories;
    _currentStory = stories[startIndex];
    _playerVisible = true;
    notifyListeners();

    final items = stories
        .map((s) => MediaItem(
              id: s.audioUrlEn ?? '',
              title: s.title,
              artist: s.source,
              artUri: s.imageUrl != null ? Uri.tryParse(s.imageUrl!) : null,
              extras: {'storyId': s.id, 'section': s.section},
            ))
        .toList();

    await _handler.loadPlaylist(items);
    await _handler.skipToQueueItem(startIndex);
    await _handler.play();
  }

  Future<void> playSingle(Story story) async => playFrom([story], 0);

  Future<void> togglePlayPause() async {
    if (isPlaying) {
      await _handler.pause();
    } else {
      await _handler.play();
    }
  }

  Future<void> skipNext() async => _handler.skipToNext();
  Future<void> skipPrev() async => _handler.skipToPrevious();

  Future<void> seek(Duration position) async => _handler.seek(position);

  void hidePlayer() {
    _playerVisible = false;
    notifyListeners();
  }
}
