from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent

COMMON = {
    '<html lang="pl">': '<html lang="en">',
    'burnit.chat — strona główna': 'burnit.chat — home',
    'aria-label="Wybierz język"': 'aria-label="Choose language"',
    'aria-label="Wersja polska" title="Polski"': 'aria-label="Polish version" title="Polski"',
}

INDEX = {
    'Jednorazowy, szyfrowany czat. Po rozłączeniu rozmowa znika.':
        'One-time encrypted chat. The conversation disappears when it ends.',
    'burnit.chat — poufny czat bez konta':
        'burnit.chat — confidential chat without an account',
    'Jak to działa?': 'How it works',
    '<i></i><span>Gotowy</span>': '<i></i><span>Ready</span>',
    'Poufny kanał 1:1': 'Confidential 1:1 channel',
    '<h1><span>Poufne?</span><br>Napisz. Przeczytaj. <em>Spal.</em></h1>':
        '<h1><span>Confidential?</span><br>Write. Read. <em>Burn.</em></h1>',
    'Jednorazowa, szyfrowana rozmowa dla dwóch osób.':
        'A one-time encrypted conversation for two people.',
    'Bez konta, bez historii i bez wiadomości zapisanych na serwerze.':
        'No account, no history, and no messages stored on the server.',
    'Utwórz bezpieczny kanał': 'Create a secure channel',
    'aria-label="Najważniejsze właściwości"': 'aria-label="Key properties"',
    'bez logowania': 'no login',
    'szyfrowanie E2EE': 'E2EE encryption',
    'tylko 2 osoby': 'only 2 people',
    'Kanał gotowy': 'Channel ready',
    'Przekaż zaproszenie': 'Share the invitation',
    'Pierwsza osoba, która otworzy link, zamknie wejście do pokoju.':
        'The first person to open the link locks the room to anyone else.',
    'aria-label="Link z zaproszeniem"': 'aria-label="Invitation link"',
    '>Kopiuj<': '>Copy<',
    'Link jest jednorazowym kluczem do wejścia. Wyślij go zaufanym kanałem.':
        'The link is a one-time key to enter. Send it through a trusted channel.',
    'Anuluj pokój': 'Cancel room',
    '<h1 id="joining-title">Łączenie…</h1>': '<h1 id="joining-title">Connecting…</h1>',
    '<p class="lead" id="joining-message">Przygotowujemy bezpieczny kanał.</p>':
        '<p class="lead" id="joining-message">Preparing a secure channel.</p>',
    'aria-label="Bezpieczny czat"': 'aria-label="Secure chat"',
    'Tunel szyfrowany end-to-end': 'End-to-end encrypted tunnel',
    'Druga osoba jest połączona': 'The other person is connected',
    '>Zakończ<': '>End<',
    '>Wiadomość<': '>Message<',
    'placeholder="Napisz wiadomość…"': 'placeholder="Write a message…"',
    'aria-label="Wyślij wiadomość"': 'aria-label="Send message"',
    'Kanał zamknięty': 'Channel closed',
    'Rozmowa zniknęła': 'The conversation is gone',
    'Tego pokoju nie można otworzyć ponownie.':
        'This room cannot be opened again.',
    'Nowa rozmowa': 'New conversation',
    'burnit.chat wymaga JavaScript / requires JavaScript do wykonania szyfrowania w przeglądarce.':
        'burnit.chat requires JavaScript to perform encryption in your browser.',
}

INFO = {
    'Jak burnit.chat tworzy jednorazowy, szyfrowany kanał rozmowy.':
        'How burnit.chat creates a one-time encrypted conversation channel.',
    'Jak to działa? — burnit.chat': 'How it works — burnit.chat',
    'Wróć do czatu': 'Back to chat',
    'Jak to działa?': 'How it works',
    'Zaszyfrowany tunel.<br><span>Tylko między wami.</span>':
        'An encrypted tunnel.<br><span>Only between you.</span>',
    'Dwie przeglądarki tworzą wspólny, poufny kanał istniejący tylko':
        'Two browsers create a shared confidential channel that exists only',
    'podczas rozmowy. Zaszyfrowane dane są przekazywane przez serwer,':
        'during the conversation. Encrypted data is forwarded by the server,',
    'ale tylko wasze przeglądarki mają klucze pozwalające je odczytać.':
        'but only your browsers have the keys required to read it.',
    '<span>TY</span>': '<span>YOU</span>',
    '<span>2. OSOBA</span>': '<span>PERSON 2</span>',
    'Najprościej mówiąc': 'Simply put',
    'Bez loginów. Bez maili. Bez kont.': 'No logins. No email. No accounts.',
    'Nie potwierdzamy tożsamości i nie zakładamy profili. Link łączy':
        'We do not verify identities or create profiles. The link connects',
    'dokładnie dwie osoby, a rozmowa żyje wyłącznie w pamięci ich':
        'exactly two people, and the conversation lives only in the memory of',
    'otwartych kart. Gdy kanał zostanie spalony, nie ma archiwum,':
        'their open browser tabs. Once the channel is burned, there is no archive',
    'do którego można wrócić.': 'to return to.',
    'aria-label="Czego nie wymagamy"': 'aria-label="What we do not require"',
    '<li>loginu</li>': '<li>login</li>',
    '<li>adresu e-mail</li>': '<li>email address</li>',
    '<li>numeru telefonu</li>': '<li>phone number</li>',
    '<li>historii konta</li>': '<li>account history</li>',
    'Wymiana kluczy': 'Key exchange',
    'Klucze prywatne nigdy nie opuszczają urządzeń.':
        'Private keys never leave the devices.',
    'Klucze publiczne przechodzą przez serwer pośredniczący, obie przeglądarki wyliczają ten sam sekret i tworzą zaszyfrowany tunel end-to-end':
        'Public keys pass through the forwarding server, both browsers calculate the same secret, and create an end-to-end encrypted tunnel',
    'serwer pośredniczący przekazuje wyłącznie dane publiczne':
        'the forwarding server handles public data only',
    '<strong>Twórca</strong>': '<strong>Creator</strong>',
    '<b>Private A</b> zostaje tutaj': '<b>Private A</b> stays here',
    '<span>SERWER</span>': '<span>SERVER</span>',
    '<strong>pośredniczący</strong>': '<strong>forwarding only</strong>',
    'przekazuje · nie odszyfrowuje': 'forwards · never decrypts',
    '<strong>Gość</strong>': '<strong>Guest</strong>',
    '<b>Private B</b> zostaje tutaj': '<b>Private B</b> stays here',
    '<em>serwer</em>': '<em>server</em>',
    '02 / lokalnie': '02 / locally',
    'ten sam sekret': 'same secret',
    'serwer widzi tylko zaszyfrowane dane': 'the server sees encrypted data only',
    'Na telefonie: najpierw obie strony wymieniają klucze publiczne przez serwer pośredniczący, następnie lokalnie obliczają ten sam sekret i otwierają zaszyfrowany tunel end-to-end':
        'On mobile: first both sides exchange public keys through the forwarding server, then locally calculate the same secret and open an end-to-end encrypted tunnel',
    'Wymiana publiczna': 'Public exchange',
    'Serwer tylko przekazuje klucze publiczne.': 'The server only forwards public keys.',
    '<em>SERWER</em>': '<em>SERVER</em>',
    'Private A i Private B nigdy nie opuszczają telefonów.':
        'Private A and Private B never leave the phones.',
    '<span>lokalnie</span>': '<span>locally</span>',
    'Ten sam sekret': 'The same secret',
    'Każda strona oblicza go u siebie.': 'Each side calculates it locally.',
    '<span>szyfrowanie</span>': '<span>encryption</span>',
    'Tunel end-to-end': 'End-to-end tunnel',
    'AES-256-GCM · osobny klucz w każdym kierunku':
        'AES-256-GCM · a separate key in each direction',
    'ZASZYFROWANE DANE': 'ENCRYPTED DATA',
    'Serwer nie ma kluczy AES i nie może przeczytać rozmowy.':
        'The server has no AES keys and cannot read the conversation.',
    'Para kluczy twórcy': "Creator's key pair",
    'Twórca generuje ulotną parę ECDH. Identyfikator pokoju to 128-bitowy skrót klucza publicznego twórcy.':
        "The creator generates an ephemeral ECDH pair. The room ID is a 128-bit digest of the creator's public key.",
    'Krótkie zaproszenie': 'Short invitation',
    'Zaproszenie zawiera tylko krótki identyfikator pokoju. Pełny klucz publiczny twórcy jest tymczasowo przechowywany w pamięci serwera.':
        "The invitation contains only a short room ID. The creator's full public key is temporarily held in server memory.",
    'Podczas dołączenia serwer przekazuje klucze publiczne obu stron. Klucze prywatne nie opuszczają przeglądarek.':
        'When the guest joins, the server forwards both public keys. Private keys never leave the browsers.',
    'Sprawdzenie klucza': 'Key verification',
    'Gość sprawdza, czy skrót klucza twórcy pasuje do identyfikatora z linku. Potem obie strony wyprowadzają klucze AES.':
        "The guest checks that the creator's key digest matches the ID in the link. Both sides then derive the AES keys.",
    'Otwarcie tunelu': 'Opening the tunnel',
    'Zaszyfrowane potwierdzenie kluczy otwiera kanał. Od tej chwili serwer widzi tylko zaszyfrowane dane.':
        'An encrypted key confirmation opens the channel. From then on, the server sees encrypted data only.',
    'Życie pokoju': 'Room lifecycle',
    'Pokój istnieje tylko tak długo, jak połączenie.':
        'The room exists only for the lifetime of the connection.',
    'Oczekiwanie': 'Waiting',
    'Zaproszenie czeka maksymalnie 15 minut i przyjmuje tylko pierwszego gościa. Twórca może bezpiecznie wrócić po chwilowym rozłączeniu przez 2 minuty, a strona gościa automatycznie ponawia połączenie co 3 sekundy.':
        'The invitation waits for up to 15 minutes and accepts only the first guest. The creator has 2 minutes to return after a brief disconnect, while the guest page retries automatically every 3 seconds.',
    'Rozmowa': 'Conversation',
    'Wiadomości istnieją w pamięci dwóch otwartych kart. Serwer nie zapisuje historii, a po chwilowej utracie połączenia obie strony mają 2 minuty na powrót.':
        'Messages exist in the memory of two open tabs. The server stores no history, and after a brief connection loss both sides have 2 minutes to return.',
    'Rozłączenie': 'Disconnect',
    'Chwilowa utrata sieci daje obu stronom 2 minuty na powrót. Świadome zakończenie natychmiast unieważnia pokój.':
        'A brief network loss gives both sides 2 minutes to return. Explicitly ending the chat invalidates the room immediately.',
    'Spalenie': 'Burn',
    'Rekord pokoju znika z MySQL, drugie gniazdo jest zamykane, a klucze i wiadomości są usuwane z widoku.':
        'The room record is removed from MySQL, the other socket is closed, and keys and messages are removed from the view.',
    'Co widzi serwer': 'What the server sees',
    '<li>identyfikator i status pokoju</li>': '<li>room ID and status</li>',
    '<li>klucze publiczne</li>': '<li>public keys</li>',
    '<li>czas i rozmiar zaszyfrowanych ramek</li>': '<li>timing and size of encrypted frames</li>',
    'Czego nie widzi': 'What it cannot see',
    '<li>treści wiadomości</li>': '<li>message contents</li>',
    '<li>kluczy prywatnych i kluczy AES</li>': '<li>private keys or AES keys</li>',
    '<li>historii rozmowy</li>': '<li>conversation history</li>',
    'Telefon podczas rozmowy': 'Using your phone during a chat',
    'Gdy pokój jest aktywny, strona prosi system o niewygaszanie ekranu.':
        'While a room is active, the page asks the system to keep the screen awake.',
    'Po przełączeniu do innej aplikacji system zwalnia tę blokadę. Jeśli WebSocket':
        'When you switch to another app, the system releases that lock. If the WebSocket',
    'zostanie wtedy przerwany, oczekujący twórca ma 2 minuty na powrót. Gość,':
        'is interrupted, the waiting creator has 2 minutes to return. A guest who',
    'który w tym czasie otworzy zaproszenie, nie musi odświeżać strony —':
        'opens the invitation during that time does not need to refresh the page —',
    'połączenie jest ponawiane automatycznie co 3 sekundy. Także podczas rozmowy':
        'the connection retries automatically every 3 seconds. During a chat,',
    'twórca i gość mają po 2 minuty na powrót do aplikacji. Wiadomości są wtedy':
        'both creator and guest have 2 minutes to return to the app. Messages are',
    'wstrzymane, a jawne zakończenie nadal natychmiast spala pokój.':
        'paused during that time, while explicitly ending the chat still burns the room immediately.',
    'Pełny link jest zaproszeniem.': 'The full link is the invitation.',
    'Osoba, która przejmie go przed pierwszym użyciem, może zająć miejsce gościa.':
        'Anyone who obtains it before first use can take the guest slot.',
    'Przy rozmowie wysokiego ryzyka porównaj kod bezpieczeństwa innym kanałem.':
        'For a high-risk conversation, compare the security code through another channel.',
    'Rozpocznij rozmowę': 'Start a conversation',
}


def build(source_name, target_name, replacements):
    content = (ROOT / source_name).read_text(encoding="utf-8")
    ordered = sorted(
        {**COMMON, **replacements}.items(),
        key=lambda item: len(item[0]),
        reverse=True,
    )
    for source, target in ordered:
        if source not in content:
            raise RuntimeError(f"Brak tekstu źródłowego w {source_name}: {source}")
        content = content.replace(source, target)

    leftovers = sorted(set(character for character in content if character in "ąćęłńóśźżĄĆĘŁŃÓŚŹŻ"))
    if leftovers:
        raise RuntimeError(
            f"Nieprzetłumaczone polskie znaki w {target_name}: {''.join(leftovers)}"
        )

    (ROOT / target_name).write_text(content, encoding="utf-8", newline="\n")
    print(f"Zbudowano {target_name}")


build("index.html", "index.en.html", INDEX)
build("jak-to-dziala.html", "how-it-works.html", INFO)
