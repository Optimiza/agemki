#ifndef AGEMKI_AUDIO_H
#define AGEMKI_AUDIO_H

/* Establece preferencia de driver antes de engine_audio_init().
 * pref: "opl2", "mpu401" o NULL para auto-detectar. */
void engine_audio_set_pref(const char* pref);
/* Activa/desactiva SFX (Sound Blaster). Llamar antes o despues de init. */
void engine_audio_set_sfx_pref(int enabled);
void engine_audio_init(const char* drv_dll, const char* patches_ad,
                       unsigned music_vol, unsigned sfx_vol);
void engine_audio_update(void);   /* llamar cada frame del game loop */
void engine_play_midi(const char* midi_id);
/* Reproduce MIDI con flag de bucle. loop=1: repetir al acabar; loop=0: una vez. */
void engine_play_midi_loop(const char* midi_id, int loop);
void engine_play_midi_cont(const char* midi_id, int loop);
void engine_stop_midi(void);
void engine_pause_midi(void);
void engine_resume_midi(void);
void engine_set_music_volume(unsigned vol);
void engine_fade_music(unsigned ms);
int  engine_midi_playing(void);
void engine_play_sfx(const char* sfx_id);
void engine_stop_sfx(const char* sfx_id);
void engine_set_sfx_volume(unsigned vol);  /* 0-127 */
/* Reinicia el hardware de audio con la preferencia establecida por
 * engine_audio_set_pref(). Reanuda la reproduccion si habia MIDI activo. */
void engine_audio_reinit(void);
void engine_audio_shutdown(void);

#endif
