// Views/SessionsPage.cs
//
// Sessions destination / 会话页。
//
// Two panes: the session list and the conversation. Nothing else — no third rail of tools, no
// template gallery. The conversation is allowed to be the largest thing on screen because it is
// the thing being worked in.

using Cyrene.Navigator.Windows.Controls;
using Cyrene.Navigator.Windows.Core;
using Cyrene.Navigator.Windows.Design;
using Microsoft.UI.Xaml.Controls;

namespace Cyrene.Navigator.Windows.Views;

public sealed class SessionsPage : Grid
{
    private readonly ConversationView _conversation;
    private readonly SessionList _list;

    public SessionsPage(IConversationService service, IAgentState agent, INavigatorUiData data)
    {
        Background = Tk.FillPaper;

        ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });
        ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });

        var sessions = service.Sessions();
        _list = new SessionList(sessions);
        _conversation = new ConversationView(service, agent, data);

        // Opening a session asks the service for that session's committed events.
        _list.Opened += session => _conversation.SetSession(session);
        if (sessions.Count > 0)
        {
            _conversation.SetSession(sessions[0]);
        }

        Children.Add(_list.At(0));
        Children.Add(_conversation.At(1));
    }

    public Composer Composer => _conversation.Composer;

    public ConversationView Conversation => _conversation;
}
