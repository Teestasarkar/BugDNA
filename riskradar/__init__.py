"""PR Risk Radar: shared feature definitions, explanations and remediation.

Everything here is used by both the offline mining pipeline and the live API,
so a feature is computed by exactly one piece of code no matter where the
pull request came from. That is the main guard against train/serve skew.
"""

__version__ = "1.0.0"
