import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:supabase_flutter/supabase_flutter.dart';

class AuthService {
  static SupabaseClient get _sb => Supabase.instance.client;

  User? get currentUser => _sb.auth.currentUser;
  bool get isSignedIn => currentUser != null;

  Stream<AuthState> get authStateChanges => _sb.auth.onAuthStateChange;

  /// Sign in with Google OAuth.
  Future<void> signInWithGoogle() async {
    await _sb.auth.signInWithOAuth(
      OAuthProvider.google,
      // On web, null lets Supabase redirect back to the current page.
      // On mobile, use the custom deep-link scheme.
      redirectTo: kIsWeb
          ? 'http://localhost:8080'
          : 'io.khabar.app://login-callback',
    );
  }

  Future<void> signOut() async {
    await _sb.auth.signOut();
  }

  /// Returns the current Supabase access token.
  String? get accessToken => _sb.auth.currentSession?.accessToken;
}
