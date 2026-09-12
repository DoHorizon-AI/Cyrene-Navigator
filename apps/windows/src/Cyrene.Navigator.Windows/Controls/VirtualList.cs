// Controls/VirtualList.cs
//
// Virtualized heterogeneous list / 虚拟化异构列表。
//
// Built on ItemsRepeater rather than ListView. ListView's default content pipeline binds the raw
// item and, without a XAML DataTemplate, falls back to ToString() — which is exactly the
// class-name wall capture mode previously showed. ItemsRepeater asks an IElementFactory for a
// concrete UIElement and never invents text from the model type.
//
// Both long lists in the product — the conversation timeline and the session list — use this.
// A 130-row transcript with dozens of code blocks only ever instantiates the rows on screen
// plus the recycle cache.
//
// 用 ItemsRepeater 做异构虚拟化：工厂直接返回控件，不会把模型 ToString 画成一行字。

using System;
using System.Collections;
using Cyrene.Navigator.Windows.Design;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Cyrene.Navigator.Windows.Controls;

public sealed class VirtualList : UserControl
{
    private readonly ItemsRepeater _repeater;
    private readonly ScrollViewer _scroll;

    /// <param name="build">
    /// Produces the view for one item. Called on realize, including on recycle reuse, so it
    /// must be cheap. Anything expensive (markdown parsing, tokenizing) belongs in a cache on
    /// the item itself, not here.
    /// </param>
    public VirtualList(Func<object, FrameworkElement?> build)
    {
        _repeater = new ItemsRepeater
        {
            Layout = new StackLayout { Orientation = Orientation.Vertical, Spacing = 0 },
            ItemTemplate = new RowFactory(build),
            HorizontalCacheLength = 0,
            VerticalCacheLength = 2,
            Background = Tk.FillTransparent,
        };

        _scroll = new ScrollViewer
        {
            Content = _repeater,
            Background = Tk.FillTransparent,
            BorderThickness = Tk.Ln.None,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
            HorizontalScrollMode = ScrollMode.Disabled,
            VerticalScrollMode = ScrollMode.Enabled,
            IsTabStop = false,
        };

        Content = _scroll;
        Background = Tk.FillTransparent;
        HorizontalAlignment = HorizontalAlignment.Stretch;
        VerticalAlignment = VerticalAlignment.Stretch;
    }

    /// <summary>Same surface as ListView.ItemsSource — ObservableCollection works.</summary>
    public object? ItemsSource
    {
        get => _repeater.ItemsSource;
        set => _repeater.ItemsSource = value;
    }

    /// <summary>Padding applied inside the scroll viewport around the realized rows.</summary>
    public new Thickness Padding
    {
        get => _repeater.Margin;
        set => _repeater.Margin = value;
    }

    /// <summary>
    /// Scrolls so <paramref name="item"/> is visible. When <paramref name="leading"/> is true the
    /// row lands near the top of the viewport — used by capture mode and deep links.
    /// </summary>
    public void ScrollIntoView(object item, bool leading = false)
    {
        var index = IndexOf(item);
        if (index < 0)
        {
            return;
        }

        // Realise the element if it is off-screen, then ask it to bring itself into view.
        var element = _repeater.GetOrCreateElement(index);
        element.StartBringIntoView(new BringIntoViewOptions
        {
            AnimationDesired = false,
            VerticalAlignmentRatio = leading ? 0.0 : 0.5,
        });
    }

    /// <summary>Scrolls to the last item without animating through the whole list.</summary>
    public void ScrollToEnd()
    {
        if (Count == 0)
        {
            return;
        }

        // Jump the viewport to the end first so GetOrCreateElement realises the tail, not the head.
        _scroll.UpdateLayout();
        _scroll.ChangeView(null, _scroll.ScrollableHeight, null, disableAnimation: true);

        var element = _repeater.GetOrCreateElement(Count - 1);
        element.StartBringIntoView(new BringIntoViewOptions
        {
            AnimationDesired = false,
            VerticalAlignmentRatio = 1.0,
        });
    }

    private int Count
    {
        get
        {
            if (_repeater.ItemsSource is ICollection collection)
            {
                return collection.Count;
            }

            if (_repeater.ItemsSource is IEnumerable enumerable)
            {
                var n = 0;
                foreach (var _ in enumerable)
                {
                    n++;
                }

                return n;
            }

            return 0;
        }
    }

    private int IndexOf(object item)
    {
        if (_repeater.ItemsSource is IList list)
        {
            return list.IndexOf(item);
        }

        if (_repeater.ItemsSource is IEnumerable enumerable)
        {
            var i = 0;
            foreach (var candidate in enumerable)
            {
                if (ReferenceEquals(candidate, item) || Equals(candidate, item))
                {
                    return i;
                }

                i++;
            }
        }

        return -1;
    }

    /// <summary>
    /// IElementFactory that materialises product-layer rows from mock / API models.
    /// WinUI 1.8 exposes the interface directly; the old ElementFactory base class is gone.
    /// </summary>
    private sealed class RowFactory : IElementFactory
    {
        private readonly Func<object, FrameworkElement?> _build;

        public RowFactory(Func<object, FrameworkElement?> build) => _build = build;

        public UIElement GetElement(ElementFactoryGetArgs args) =>
            _build(args.Data!) ?? new Border { Height = 0 };

        public void RecycleElement(ElementFactoryRecycleArgs args)
        {
            // Views are discarded on recycle. Keeping them would pin large visual trees for
            // off-screen tool cards and code blocks; the model-side caches already preserve cost.
            if (args.Element is FrameworkElement element)
            {
                element.DataContext = null;
            }
        }
    }
}
