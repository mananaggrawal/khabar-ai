/// Data models mirroring the TypeScript types in generator.ts

class StorySource {
  final String title;
  final String source;
  final String link;

  const StorySource({
    required this.title,
    required this.source,
    required this.link,
  });

  factory StorySource.fromJson(Map<String, dynamic> j) => StorySource(
        title: j['title'] as String? ?? '',
        source: j['source'] as String? ?? '',
        link: j['link'] as String? ?? '',
      );
}

class Story {
  final String id;
  final String title;
  final String source;
  final String link;
  final String publishedAt;
  final String section;
  final String? imageUrl;
  final String? description;
  final String scriptEn;
  final String? audioUrlEn;
  final double? audioStartSec;
  final List<StorySource> sources;

  const Story({
    required this.id,
    required this.title,
    required this.source,
    required this.link,
    required this.publishedAt,
    required this.section,
    required this.scriptEn,
    this.imageUrl,
    this.description,
    this.audioUrlEn,
    this.audioStartSec,
    this.sources = const [],
  });

  factory Story.fromJson(Map<String, dynamic> j) => Story(
        id: j['id'] as String? ?? '',
        title: j['title'] as String? ?? '',
        source: j['source'] as String? ?? '',
        link: j['link'] as String? ?? '',
        publishedAt: j['publishedAt'] as String? ?? '',
        section: j['section'] as String? ?? 'headlines',
        scriptEn: j['scriptEn'] as String? ?? '',
        imageUrl: j['imageUrl'] as String?,
        description: j['description'] as String?,
        audioUrlEn: j['audioUrlEn'] as String?,
        audioStartSec: (j['audioStartSec'] as num?)?.toDouble(),
        sources: (j['sources'] as List<dynamic>?)
                ?.map((s) => StorySource.fromJson(s as Map<String, dynamic>))
                .toList() ??
            [],
      );
}

class DailyBriefing {
  final String date;
  final String generatedAt;
  final List<Story> stories;

  const DailyBriefing({
    required this.date,
    required this.generatedAt,
    required this.stories,
  });

  factory DailyBriefing.fromJson(Map<String, dynamic> j) => DailyBriefing(
        date: j['date'] as String? ?? '',
        generatedAt: j['generatedAt'] as String? ?? '',
        stories: (j['stories'] as List<dynamic>?)
                ?.map((s) => Story.fromJson(s as Map<String, dynamic>))
                .toList() ??
            [],
      );

  List<String> get sections {
    final seen = <String>{};
    final order = ['headlines', 'india', 'world', 'business', 'local'];
    final result = <String>[];
    for (final s in order) {
      if (stories.any((st) => st.section == s)) result.add(s);
      seen.add(s);
    }
    // any unexpected sections
    for (final st in stories) {
      if (!seen.contains(st.section)) {
        seen.add(st.section);
        result.add(st.section);
      }
    }
    return result;
  }

  List<Story> storiesForSection(String section) =>
      stories.where((s) => s.section == section).toList();
}
