"""Production settings. Run `gunicorn` from the project folder on Linux."""

wsgi_app = "app:create_app()"
bind = "127.0.0.1:8080"
workers = 2
# Initialize the shared database and signing secret once before workers fork.
preload_app = True
accesslog = "-"
errorlog = "-"
