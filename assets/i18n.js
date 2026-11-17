export const language = document.documentElement.lang === 'en' ? 'en' : 'pl';

const english = new Map(Object.entries({
    'Brak publicznego adresu aplikacji w config.js.':
        'The public application URL is missing from config.js.',
    'Brak poprawnego adresu serwera WebSocket w config.js.':
        'A valid WebSocket server URL is missing from config.js.',
    'Strona HTTPS wymaga bezpiecznego połączenia wss://.':
        'An HTTPS page requires a secure wss:// connection.',
    'Twórca jest niedostępny': 'The creator is unavailable',
    'Przez 2 minuty nie udało się połączyć z twórcą pokoju. Poproś o nowe zaproszenie.':
        'The creator could not be reached for 2 minutes. Ask for a new invitation.',
    'Twórca chwilowo niedostępny': 'The creator is temporarily unavailable',
    'Ponawiamy połączenie co 3 sekundy przez maksymalnie 2 minuty. Nie odświeżaj strony.':
        'Retrying every 3 seconds for up to 2 minutes. Do not refresh the page.',
    'Oczekiwanie na twórcę': 'Waiting for the creator',
    'Ponawianie połączenia': 'Retrying connection',
    'Oczekiwanie': 'Waiting',
    'Pokój wygasł': 'The room expired',
    'Rozmowa wygasła': 'The conversation expired',
    'Nie udało się wznowić połączenia w ciągu 2 minut.':
        'The connection could not be resumed within 2 minutes.',
    'Wznawianie': 'Reconnecting',
    'Negocjowanie': 'Negotiating',
    'Serwer nie odpowiada pod {endpoint}. Sprawdź, czy usługa WebSocket jest uruchomiona.':
        'The server is not responding at {endpoint}. Check whether the WebSocket service is running.',
    'Serwer zamknął połączenie przed utworzeniem pokoju.':
        'The server closed the connection before the room was created.',
    'Połączenie przerwane — próbujemy wrócić przez 2 minuty.':
        'Connection interrupted — retrying for up to 2 minutes.',
    'Połączenie zostało przerwane': 'The connection was interrupted',
    'Pokój został unieważniony. Klucze zwolniono z pamięci tej karty.':
        'The room was invalidated. Keys were released from this tab.',
    'Brak aktywnego połączenia z serwerem.':
        'There is no active connection to the server.',
    'Ta strona nie ma bezpiecznego kontekstu':
        'This page does not have a secure context',
    'Szyfrowanie w przeglądarce wymaga otwarcia strony przez HTTPS.':
        'Browser encryption requires opening the page over HTTPS.',
    'Tworzenie': 'Creating',
    'Nie udało się utworzyć pokoju': 'The room could not be created',
    'Łączenie': 'Connecting',
    'Łączenie…': 'Connecting…',
    'Przygotowujemy bezpieczny kanał.': 'Preparing a secure channel.',
    'Nie udało się wejść do pokoju': 'The room could not be joined',
    'Nieprawidłowa odpowiedź serwera.': 'Invalid server response.',
    'Błąd protokołu': 'Protocol error',
    'Serwer wysłał nieprawidłową odpowiedź.': 'The server sent an invalid response.',
    'Druga osoba opuściła rozmowę': 'The other person left the conversation',
    'Pokój został natychmiast zniszczony i nie można do niego wrócić.':
        'The room was destroyed immediately and cannot be reopened.',
    'Błąd bezpiecznego kanału': 'Secure channel error',
    'Połączenie wznowione. Czekamy do 2 minut na drugą osobę.':
        'Connection restored. Waiting up to 2 minutes for the other person.',
    'Druga osoba zmieniła aplikację lub straciła połączenie. Czekamy do 2 minut.':
        'The other person switched apps or lost the connection. Waiting up to 2 minutes.',
    'Kod bezpieczeństwa: {code} · porównaj innym kanałem':
        'Security code: {code} · compare through another channel',
    'Szyfrowany': 'Encrypted',
    'Druga osoba jest offline': 'The other person is offline',
    'Nie udało się potwierdzić kluczy': 'The keys could not be confirmed',
    'Druga strona nie ukończyła negocjacji bezpiecznego kanału.':
        'The other side did not complete the secure channel negotiation.',
    'Pokój nie istnieje': 'The room does not exist',
    'Zaproszenie wygasło albo rozmowa już się zakończyła.':
        'The invitation expired or the conversation has already ended.',
    'Wróć do zaproszenia za moment. Twórca pokoju może właśnie wracać do przeglądarki.':
        'Return to the invitation in a moment. The creator may be returning to the browser.',
    'Nie udało się bezpiecznie wznowić połączenia w ciągu 2 minut.':
        'The secure connection could not be resumed within 2 minutes.',
    'Pokój jest już zajęty': 'The room is already occupied',
    'Pierwszy gość zatrzasnął pokój. To zaproszenie nie może być użyte ponownie.':
        'The first guest locked the room. This invitation cannot be used again.',
    'Wystąpiła kolizja identyfikatora. Spróbuj ponownie.':
        'An ID collision occurred. Please try again.',
    'Nieprawidłowe żądanie': 'Invalid request',
    'Serwer odrzucił dane połączenia.': 'The server rejected the connection data.',
    'Zbyt wiele wiadomości': 'Too many messages',
    'Serwer zakończył połączenie z powodu przekroczenia limitu.':
        'The server ended the connection because the limit was exceeded.',
    'Błąd serwera': 'Server error',
    'Pokój został zamknięty bez zachowania danych.':
        'The room was closed without storing any data.',
    'Połączenie odrzucone': 'Connection rejected',
    'Nie udało się kontynuować rozmowy.': 'The conversation could not continue.',
    'Zamknięty': 'Closed',
    'Nie udało się wysłać wiadomości': 'The message could not be sent',
    'Skopiowano': 'Copied',
    'Kopiuj': 'Copy',
    'Pokój anulowany': 'Room cancelled',
    'Zaproszenie zostało unieważnione.': 'The invitation was invalidated.',
    'Rozmowa zakończona': 'Conversation ended',
    'Pokój został zniszczony, a klucze zwolniono z pamięci tej karty.':
        'The room was destroyed and the keys were released from this tab.',
    'Nieprawidłowe kodowanie base64url.': 'Invalid base64url encoding.',
    'Nieprawidłowy klucz publiczny P-256.': 'Invalid P-256 public key.',
    'Kanał kryptograficzny został zamknięty.': 'The cryptographic channel was closed.',
    'Nieobsługiwana wersja zaszyfrowanej wiadomości.':
        'Unsupported encrypted message version.',
    'Nieprawidłowa zaszyfrowana wiadomość.': 'Invalid encrypted message.',
    'Odrzucono powtórzoną lub nieuporządkowaną wiadomość.':
        'A repeated or out-of-order message was rejected.',
    'Nieznany typ odpowiedzi serwera.': 'Unknown server response type.',
    'Nieoczekiwane potwierdzenie pokoju.': 'Unexpected room confirmation.',
    'Nieoczekiwane potwierdzenie wznowienia pokoju.':
        'Unexpected room resume confirmation.',
    'Nieprawidłowy stan wznowionego pokoju.': 'Invalid resumed room state.',
    'Nieoczekiwana informacja o rozłączeniu drugiej osoby.':
        'Unexpected notification that the other person disconnected.',
    'Nieoczekiwana informacja o powrocie drugiej osoby.':
        'Unexpected notification that the other person returned.',
    'Nieprawidłowe dane drugiego uczestnika.': 'Invalid peer data.',
    'Nieoczekiwane potwierdzenie dołączenia.': 'Unexpected join confirmation.',
    'Klucz publiczny twórcy nie pasuje do identyfikatora zaproszenia.':
        "The creator's public key does not match the invitation ID.",
    'Odebrano dane przed utworzeniem klucza.':
        'Data was received before the key was established.',
    'Nie udało się potwierdzić klucza.': 'The key could not be confirmed.',
    'Odrzucono nieprawidłową wiadomość.': 'An invalid message was rejected.',
    'Odrzucono wiadomość niezgodną ze stanem sesji.':
        'A message inconsistent with the session state was rejected.'
}));

export function t(source, values = {}) {
    let translated = language === 'en' ? (english.get(source) ?? source) : source;
    for (const [name, value] of Object.entries(values)) {
        translated = translated.replaceAll(`{${name}}`, String(value));
    }
    return translated;
}

export function translateError(error) {
    return t(error instanceof Error ? error.message : String(error));
}
