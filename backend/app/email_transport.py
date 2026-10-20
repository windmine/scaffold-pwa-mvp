"""Certificate-verified SMTP with sanitized failure outcomes and no retries."""
from email.headerregistry import Address
from email.errors import HeaderParseError
from email.message import EmailMessage
import smtplib
import ssl

from app.config import (
    SMTP_FROM_EMAIL, SMTP_HOST, SMTP_PASSWORD, SMTP_PORT, SMTP_USERNAME,
    SMTP_USE_SSL, SMTP_USE_STARTTLS,
)


class EmailSendError(Exception):
    def __init__(self, outcome="failed"):
        self.outcome = outcome
        super().__init__("Email acceptance could not be confirmed" if outcome == "unknown" else "Email was not sent")


def smtp_is_configured():
    return bool(SMTP_HOST and SMTP_FROM_EMAIL)


def validate_mailbox(address):
    try:
        if not address or any(character in address for character in "\r\n"):
            raise ValueError()
        parsed = Address(addr_spec=address)
        if not parsed.username or not parsed.domain:
            raise ValueError()
    except (ValueError, IndexError, HeaderParseError):
        raise EmailSendError() from None


def require_smtp_configuration():
    if not smtp_is_configured() or (not SMTP_USE_SSL and not SMTP_USE_STARTTLS):
        raise EmailSendError()
    validate_mailbox(SMTP_FROM_EMAIL)


def send_email(recipient, subject, body):
    """Return only after SMTP acceptance; this does not establish delivery."""
    require_smtp_configuration()
    validate_mailbox(recipient)
    message = EmailMessage()
    message["From"] = SMTP_FROM_EMAIL
    message["To"] = recipient
    message["Subject"] = subject
    message.set_content(body)
    context = ssl.create_default_context()
    options = {"timeout": 15}
    if SMTP_USE_SSL:
        options["context"] = context
    client = None
    sending = False
    try:
        client = (smtplib.SMTP_SSL if SMTP_USE_SSL else smtplib.SMTP)(SMTP_HOST, SMTP_PORT, **options)
        client.set_debuglevel(0)
        if not SMTP_USE_SSL:
            client.starttls(context=context)
        if SMTP_USERNAME:
            client.login(SMTP_USERNAME, SMTP_PASSWORD)
        sending = True
        refused = client.send_message(message, from_addr=SMTP_FROM_EMAIL, to_addrs=[recipient])
        if refused:
            raise EmailSendError()
    except EmailSendError:
        raise
    except (smtplib.SMTPRecipientsRefused, smtplib.SMTPSenderRefused, smtplib.SMTPDataError):
        raise EmailSendError() from None
    except Exception:
        # Never include server text, message content or credentials in errors.
        # A lost DATA response may follow acceptance: do not retry it.
        raise EmailSendError("unknown" if sending else "failed") from None
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:
                # Disconnect failure cannot undo an acknowledged acceptance.
                pass
